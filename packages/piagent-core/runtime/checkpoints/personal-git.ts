import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspacePathFlags, type WorkspacePolicy } from '../../extensions/workspace-inspection.ts';
import { inspectWorkspaceEntry, readWorkspaceFile, readWorkspaceLink } from '../../security/workspace-file-reader.ts';

const MAX_FILE = 16 << 20, MAX_TOTAL = 64 << 20, MAX_FILES = 10000;
const executable = process.platform === 'darwin' ? '/usr/bin/git' : 'git';
const oid = (value: string) => { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw Error('checkpoint-object-invalid'); return value; };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const internal = (file: string) => file.split('/').includes('.git') || file === '.pi/piagent-state' || file.startsWith('.pi/piagent-state/');
function valid(file: string) {
  if (!file || file.length > 4096 || /[\\\x00-\x1f\x7f]/.test(file) || path.isAbsolute(file)
    || file.split('/').some(part => !part || part === '.' || part === '..') || internal(file)) throw Error('checkpoint-path-invalid');
}
type FileState = { mode: string; bytes: Buffer; fingerprint: string; permissions: number };
type TreeEntry = { mode: string; object: string; file: string };

// Snapshots use raw, policy-checked bytes and an empty private index. Neither
// Git filters nor checkout commands get to read/write arbitrary workspace paths.
export class PersonalCheckpointGit {
  readonly root: string;
  readonly #policy: () => WorkspacePolicy;
  #repository: string | null = null;
  constructor(root: string, policy: () => WorkspacePolicy) { this.root = fs.realpathSync(root); this.#policy = policy; }
  #run(args: string[], input?: Buffer, index?: string, cwd = this.root): Buffer {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', ...(index ? { GIT_INDEX_FILE: index } : {}) });
    return execFileSync(executable, ['-C', cwd, ...args], { env, input, timeout: 120000, maxBuffer: MAX_TOTAL,
      stdio: ['pipe', 'pipe', 'pipe'] });
  }
  #top(): string | null {
    if (fs.realpathSync(this.root) !== this.root) throw Error('checkpoint-project-changed');
    let top: string;
    try { top = fs.realpathSync(this.#run(['rev-parse', '--show-toplevel']).toString().trim()); }
    catch (error) {
      if (!this.#repository && /not a git repository/i.test(String((error as { stderr?: Buffer }).stderr))) return null;
      throw Error('checkpoint-repository-unavailable');
    }
    const relative = path.relative(top, this.root);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || this.#repository && this.#repository !== top)
      throw Error('checkpoint-project-changed');
    this.#repository = top; return top;
  }
  available() { return this.#top() !== null; }
  #flags(file: string, write = false) {
    valid(file);
    const policy = this.#policy(), flags = workspacePathFlags(file, policy);
    if (flags.protected) throw Error(`checkpoint-path-protected: ${file}`);
    if (write && (flags.readOnly || policy.readOnly === undefined && policy.profile.permissionProfile === 'read-only'))
      throw Error(`checkpoint-read-only: ${file}`);
  }
  #state(file: string): FileState | null {
    this.#flags(file);
    let stat: fs.Stats;
    try { stat = inspectWorkspaceEntry(this.root, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    let mode: string, bytes: Buffer;
    if (stat.isSymbolicLink()) { mode = '120000'; bytes = Buffer.from(readWorkspaceLink(this.root, file)); }
    else if (stat.isFile()) { mode = stat.mode & 0o111 ? '100755' : '100644'; bytes = readWorkspaceFile(this.root, file, MAX_FILE); }
    else throw Error(`checkpoint-unsupported-entry: ${file}`);
    const after = inspectWorkspaceEntry(this.root, file);
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mode !== after.mode || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      throw Error(`checkpoint-content-changed: ${file}`);
    return { mode, bytes, permissions: stat.mode & 0o777, fingerprint: `${mode}:${digest(bytes)}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}` };
  }
  #files() {
    const files = [...new Set(this.#run(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'])
      .toString('utf8').split('\0').filter(Boolean))].sort();
    if (files.length > MAX_FILES) throw Error('checkpoint-file-limit');
    return files.filter(file => {
      if (internal(file)) return false;
      valid(file); return !workspacePathFlags(file, this.#policy()).protected;
    });
  }
  tree(): string | null {
    const top = this.#top(); if (!top) return null;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-checkpoint-')); fs.chmodSync(temporary, 0o700);
    const index = path.join(temporary, 'index');
    try {
      const files = this.#files(), states = new Map<string, string | null>(), records: string[] = [];
      let bytes = 0;
      this.#run(['read-tree', '--empty'], undefined, index, top);
      for (const file of files) {
        const state = this.#state(file); states.set(file, state?.fingerprint ?? null); if (!state) continue;
        if ((bytes += state.bytes.length) > MAX_TOTAL) throw Error('checkpoint-byte-limit');
        const object = oid(this.#run(['hash-object', '-w', '--no-filters', '--stdin'], state.bytes).toString().trim());
        records.push(`${state.mode} ${object}\t${file}\0`);
      }
      this.#run(['update-index', '-z', '--index-info'], Buffer.from(records.join('')), index, top);
      const tree = oid(this.#run(['write-tree'], undefined, index, top).toString().trim());
      if (JSON.stringify(this.#files()) !== JSON.stringify(files)) throw Error('checkpoint-files-changed');
      for (const [file, fingerprint] of states) if ((this.#state(file)?.fingerprint ?? null) !== fingerprint)
        throw Error(`checkpoint-content-changed: ${file}`);
      return tree;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  #entries(tree: string): Map<string, TreeEntry> {
    const records = this.#run(['ls-tree', '--full-tree', '-r', '-z', oid(tree)]).toString('utf8').split('\0').filter(Boolean);
    if (records.length > MAX_FILES) throw Error('checkpoint-file-limit');
    const entries = new Map<string, TreeEntry>();
    for (const record of records) {
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(record);
      if (!match) throw Error('checkpoint-tree-invalid');
      const mode = match[1]!, object = match[2]!, file = match[3]!; valid(file);
      if (entries.has(file)) throw Error('checkpoint-tree-invalid');
      entries.set(file, { mode, object, file });
    }
    return entries;
  }
  changed(from: string, to: string) {
    this.#top();
    const before = this.#entries(from), after = this.#entries(to);
    return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(file => {
      const a = before.get(file), b = after.get(file);
      return a?.object === b?.object && a?.mode === b?.mode ? [] : [{ status: !a ? 'A' : !b ? 'D' : 'M', path: file }];
    });
  }
  restore(before: string, restore: string[], remove: string[], expectedTree?: string) {
    if (!expectedTree) throw Error('checkpoint-current-tree-required');
    const currentTree = this.tree();
    if (currentTree !== oid(expectedTree)) {
      const affected = new Set([...restore, ...remove]);
      const changed = currentTree ? this.changed(expectedTree, currentTree).map(entry => entry.path).filter(file => affected.has(file)) : [];
      if (!currentTree || changed.length) throw Error(`checkpoint-content-changed${changed.length ? ': ' + changed.slice(0, 5).join(', ') : ''}`);
    }
    const entries = this.#entries(before), files = [...restore, ...remove];
    if (files.length > MAX_FILES || new Set(files).size !== files.length) throw Error('checkpoint-file-limit');
    const states = new Map<string, FileState | null>(), contents = new Map<string, Buffer>();
    let bytes = 0;
    for (const file of files) {
      this.#flags(file, true); states.set(file, this.#state(file));
      if (!restore.includes(file)) continue;
      const entry = entries.get(file); if (!entry) throw Error('checkpoint-tree-invalid');
      const size = Number(this.#run(['cat-file', '-s', entry.object]).toString().trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE || (bytes += size) > MAX_TOTAL) throw Error('checkpoint-byte-limit');
      contents.set(file, this.#run(['cat-file', 'blob', entry.object]));
    }
    // Preflight every file before the first effect; recheck it again immediately
    // before its atomic replacement. No Git checkout/filter can bypass policy.
    for (const file of files) {
      this.#flags(file, true);
      if ((this.#state(file)?.fingerprint ?? null) !== (states.get(file)?.fingerprint ?? null)) throw Error(`checkpoint-content-changed: ${file}`);
    }
    for (const file of files) {
      this.#flags(file, true);
      if ((this.#state(file)?.fingerprint ?? null) !== (states.get(file)?.fingerprint ?? null)) throw Error(`checkpoint-content-changed: ${file}`);
      const target = path.join(this.root, file);
      if (remove.includes(file)) { if (states.get(file)) fs.unlinkSync(target); continue; }
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/'); this.#flags(parent, true);
        try { fs.mkdirSync(path.join(this.root, parent)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const stat = inspectWorkspaceEntry(this.root, parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('checkpoint-unsafe-parent');
      }
      const parent = path.dirname(target), parentStat = fs.lstatSync(parent);
      const temporary = path.join(parent, `.piagent-checkpoint-${randomUUID()}`), entry = entries.get(file)!;
      try {
        if (entry.mode === '120000') fs.symlinkSync(contents.get(file)!.toString('utf8'), temporary);
        else {
          const fd = fs.openSync(temporary, 'wx', 0o600);
          try {
            fs.writeFileSync(fd, contents.get(file)!);
            fs.fchmodSync(fd, ((states.get(file)?.permissions ?? 0o600) & 0o666) | (entry.mode === '100755' ? 0o111 : 0));
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
        }
        this.#flags(file, true);
        const currentParent = fs.lstatSync(parent);
        if (fs.realpathSync(parent) !== parent || currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino
          || (this.#state(file)?.fingerprint ?? null) !== (states.get(file)?.fingerprint ?? null)) throw Error(`checkpoint-content-changed: ${file}`);
        fs.renameSync(temporary, target);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  }
  // Only the ref manager receives this plumbing port; it never accepts shell.
  readonly refsExecutor = { run: (args: string[], input?: Buffer) => {
    if (!this.#top() || !['for-each-ref', 'update-ref'].includes(args[0] ?? '')) throw Error('checkpoint-ref-command-invalid');
    return this.#run(args, input).toString('utf8');
  } };
}
