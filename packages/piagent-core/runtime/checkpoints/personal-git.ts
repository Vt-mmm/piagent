import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspacePathFlags, type WorkspacePolicy } from '../../extensions/workspace-inspection.ts';
import { effectiveProtectedPaths, matchesProtectedPath } from '../../extensions/workspace-policy.js';
import { inspectWorkspaceEntry, readWorkspaceLink, WorkspaceReadError } from '../../security/workspace-file-reader.ts';

// Untracked files above this size (a dataset, a build artifact nobody ignored)
// stay out of snapshots: undo leaves them alone rather than copying them into
// Git objects on every turn. Tracked files of any size are included.
const MAX_UNTRACKED = 100 << 20, MAX_ENTRIES = 500000, OUTPUT = 256 << 20;
const executable = process.platform === 'darwin' ? '/usr/bin/git' : 'git';
const oid = (value: string) => { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw Error('checkpoint-object-invalid'); return value; };
const internal = (file: string) => file.split('/').includes('.git') || file === '.pi/piagent-state' || file.startsWith('.pi/piagent-state/');
const safe = (file: string) => Boolean(file) && file.length <= 4096 && !/[\\\x00-\x1f\x7f]/.test(file) && !path.isAbsolute(file)
  && !file.split('/').some(part => !part || part === '.' || part === '..') && !internal(file);
function valid(file: string) { if (!safe(file)) throw Error('checkpoint-path-invalid'); }
type FileState = { mode: string; fingerprint: string; permissions: number };
type TreeEntry = { mode: string; object: string; file: string };
type Hashed = { key: string; object: string };
const statKey = (stat: fs.Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;

// Snapshots hash raw bytes into a private index; neither Git filters nor
// checkout commands read or write workspace paths. One `hash-object
// --stdin-paths` per snapshot, and files unchanged since the last snapshot are
// not read again. Files Git cannot snapshot as blobs (submodules, sockets) are
// left out, so undo never touches them, instead of failing the turn.
// With `store`, objects and refs live in a private repository inside the Git
// directory: `git push --mirror` and the project's refs never see them, and the
// project's objects serve as alternates so tracked content is not copied.
export class PersonalCheckpointGit {
  readonly root: string;
  readonly #policy: () => WorkspacePolicy;
  readonly #store: boolean;
  #repository: string | null = null;
  #objects: string | undefined;
  #hashed = new Map<string, Hashed>();
  constructor(root: string, policy: () => WorkspacePolicy, { store = false }: { store?: boolean } = {}) {
    this.root = fs.realpathSync(root); this.#policy = policy; this.#store = store;
  }
  #run(args: string[], input?: Buffer, index?: string, cwd = this.root, objects: string | null | undefined = this.#objects, output?: number): Buffer {
    // `objects` null: the project's own repository (listing files, finding it).
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', ...(index ? { GIT_INDEX_FILE: index } : {}) });
    const argv = ['-C', cwd, ...(objects ? [`--git-dir=${objects}`] : []), ...args];
    return execFileSync(executable, argv, { env, input, timeout: 120000, maxBuffer: OUTPUT,
      stdio: [input ? 'pipe' : 'ignore', output ?? 'pipe', 'pipe'] }) ?? Buffer.alloc(0);
  }
  #top(): string | null {
    if (fs.realpathSync(this.root) !== this.root) throw Error('checkpoint-project-changed');
    let top: string;
    try { top = fs.realpathSync(this.#run(['rev-parse', '--show-toplevel'], undefined, undefined, this.root, null).toString().trim()); }
    catch (error) {
      if (!this.#repository && /not a git repository/i.test(String((error as { stderr?: Buffer }).stderr))) return null;
      throw Error('checkpoint-repository-unavailable');
    }
    const relative = path.relative(top, this.root);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || this.#repository && this.#repository !== top)
      throw Error('checkpoint-project-changed');
    this.#repository = top;
    if (this.#store && !this.#objects) this.#objects = this.#openStore();
    return top;
  }
  #openStore(): string {
    const common = path.resolve(this.root, this.#run(['rev-parse', '--git-common-dir'], undefined, undefined, this.root, null).toString().trim());
    const parent = path.join(common, 'piagent'), store = path.join(parent, 'checkpoints.git');
    for (const directory of [parent, store]) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw Error('checkpoint-store-invalid');
    }
    if (!fs.existsSync(path.join(store, 'HEAD'))) this.#run(['init', '--bare', '--quiet', '--template=', store], undefined, undefined, this.root, null);
    const alternates = path.join(store, 'objects', 'info', 'alternates'), objects = path.join(common, 'objects') + '\n';
    fs.mkdirSync(path.dirname(alternates), { recursive: true });
    if (!fs.existsSync(alternates) || fs.readFileSync(alternates, 'utf8') !== objects) fs.writeFileSync(alternates, objects, { mode: 0o600 });
    return store;
  }
  available() { return this.#top() !== null; }
  #flags(file: string, write = false) {
    valid(file);
    const policy = this.#policy(), flags = workspacePathFlags(file, policy);
    if (flags.protected) throw Error(`checkpoint-path-protected: ${file}`);
    if (write && (flags.readOnly || policy.readOnly === undefined && policy.profile.permissionProfile === 'read-only'))
      throw Error(`checkpoint-read-only: ${file}`);
  }
  // Drift checks compare identity and timestamps, which every write changes,
  // so a restore never reads whole files into memory.
  #state(file: string): FileState | null {
    this.#flags(file);
    let stat: fs.Stats;
    try { stat = inspectWorkspaceEntry(this.root, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    let mode: string, link = '';
    if (stat.isSymbolicLink()) { mode = '120000'; link = readWorkspaceLink(this.root, file); }
    else if (stat.isFile()) mode = stat.mode & 0o111 ? '100755' : '100644';
    else throw Error(`checkpoint-unsupported-entry: ${file}`);
    return { mode, permissions: stat.mode & 0o777, fingerprint: `${mode}:${statKey(stat)}:${link}` };
  }
  #list(args: string[]) {
    return this.#run(['ls-files', ...args, '-z', '--', '.'], undefined, undefined, this.root, null)
      .toString('utf8').split('\0').filter(Boolean);
  }
  #hash(files: { file: string; key: string }[], top: string): string[] {
    if (!files.length) return [];
    const input = Buffer.from(files.map(item => path.join(this.root, item.file)).join('\n') + '\n');
    try {
      const objects = this.#run(['hash-object', '-w', '--no-filters', '--stdin-paths'], input, undefined, top).toString().trim().split('\n');
      if (objects.length !== files.length) throw Error('checkpoint-object-invalid');
      return objects.map(oid);
    } catch {
      // A file removed while the batch ran: hash the rest one by one.
      return files.map(item => {
        try { return oid(this.#run(['hash-object', '-w', '--no-filters', '--', path.join(this.root, item.file)], undefined, undefined, top).toString().trim()); }
        catch { if (!fs.existsSync(path.join(this.root, item.file))) return ''; throw Error(`checkpoint-hash-failed: ${item.file}`); }
      });
    }
  }
  tree(): string | null {
    const top = this.#top(); if (!top) return null;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-checkpoint-')); fs.chmodSync(temporary, 0o700);
    const index = path.join(temporary, 'index'), policy = this.#policy();
    // workspacePathFlags(...).protected, with each folder decided once per snapshot.
    const patterns = effectiveProtectedPaths(policy.policy, policy.profile).readProtectedPaths, known = new Map<string, boolean>();
    const protectedPath = (file: string) => file.split('/').some((_, i, parts) => {
      const prefix = parts.slice(0, i + 1).join('/');
      if (!known.has(prefix)) known.set(prefix, !!matchesProtectedPath(prefix, patterns));
      return known.get(prefix);
    });
    try {
      const tracked = new Set(this.#list(['--cached'])), records: string[] = [], pending: { file: string; mode: string; key: string }[] = [];
      const listed = [...new Set(this.#list(['--cached', '--others', '--exclude-standard']))].sort();
      if (listed.length > MAX_ENTRIES) throw Error('checkpoint-file-limit');
      const now = Date.now(), seen = new Set<string>();
      for (const file of listed) {
        if (!safe(file) || protectedPath(file)) continue;
        let stat: fs.Stats;
        try { stat = inspectWorkspaceEntry(this.root, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof WorkspaceReadError) continue; throw error; }
        if (stat.isSymbolicLink()) {
          let target: string;
          try { target = readWorkspaceLink(this.root, file); } catch { continue; }
          const object = oid(this.#run(['hash-object', '-w', '--no-filters', '--stdin'], Buffer.from(target), undefined, top).toString().trim());
          records.push(`120000 ${object}\t${file}\0`); continue;
        }
        if (!stat.isFile() || !tracked.has(file) && stat.size > MAX_UNTRACKED) continue;
        const mode = stat.mode & 0o111 ? '100755' : '100644', key = statKey(stat), known = this.#hashed.get(file);
        seen.add(file);
        if (known?.key === key) records.push(`${mode} ${known.object}\t${file}\0`);
        // A file written within the last two seconds may change again without
        // moving its timestamp: hash it now, remember it next time.
        else pending.push({ file, mode, key: now - stat.mtimeMs > 2000 ? key : '' });
      }
      this.#hash(pending, top).forEach((object, i) => {
        const item = pending[i]!; if (!object) return;
        if (item.key) this.#hashed.set(item.file, { key: item.key, object }); else this.#hashed.delete(item.file);
        records.push(`${item.mode} ${object}\t${item.file}\0`);
      });
      for (const file of this.#hashed.keys()) if (!seen.has(file)) this.#hashed.delete(file);
      this.#run(['read-tree', '--empty'], undefined, index, top);
      this.#run(['update-index', '-z', '--index-info'], Buffer.from(records.join('')), index, top);
      return oid(this.#run(['write-tree'], undefined, index, top).toString().trim());
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  #entries(tree: string): Map<string, TreeEntry> {
    const records = this.#run(['ls-tree', '--full-tree', '-r', '-z', oid(tree)]).toString('utf8').split('\0').filter(Boolean);
    if (records.length > MAX_ENTRIES) throw Error('checkpoint-file-limit');
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
    const entries = this.#entries(before), files = [...restore, ...remove], current = this.#entries(expectedTree);
    if (files.length > MAX_ENTRIES || new Set(files).size !== files.length) throw Error('checkpoint-file-limit');
    const states = new Map<string, FileState | null>(), objects: string[] = [];
    for (const file of files) {
      this.#flags(file, true); states.set(file, this.#state(file));
      // On disk but outside the current snapshot (ignored since, or too large
      // to snapshot): its present content was never compared, so keep it.
      if (states.get(file) && !current.has(file)) throw Error(`checkpoint-content-changed: ${file}`);
      if (!restore.includes(file)) continue;
      const entry = entries.get(file); if (!entry) throw Error('checkpoint-tree-invalid');
      objects.push(entry.object);
    }
    // Every object must be readable before the first file changes; contents are
    // then streamed straight into each replacement, whatever their size.
    if (objects.length) {
      const missing = this.#run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], Buffer.from(objects.join('\n') + '\n'))
        .toString().trim().split('\n').filter(line => !/^[a-f0-9]+ blob$/.test(line));
      if (missing.length) throw Error('checkpoint-object-missing');
    }
    // Preflight every file before the first effect; recheck it again immediately
    // before its atomic replacement. No Git checkout/filter can bypass policy.
    for (const file of files) {
      this.#flags(file, true);
      if ((this.#state(file)?.fingerprint ?? null) !== (states.get(file)?.fingerprint ?? null)) throw Error(`checkpoint-content-changed: ${file}`);
    }
    // An error after the first file changed says so (checkpoint-partial), so
    // the caller reports an uncertain result rather than a clean refusal.
    let changed = 0;
    try { for (const file of files) {
      this.#flags(file, true);
      if ((this.#state(file)?.fingerprint ?? null) !== (states.get(file)?.fingerprint ?? null)) throw Error(`checkpoint-content-changed: ${file}`);
      const target = path.join(this.root, file);
      if (remove.includes(file)) { if (states.get(file)) { fs.unlinkSync(target); changed++; this.#prune(file, entries); } continue; }
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
        if (entry.mode === '120000') fs.symlinkSync(this.#run(['cat-file', 'blob', entry.object]).toString('utf8'), temporary);
        else {
          const fd = fs.openSync(temporary, 'wx', 0o600);
          try {
            this.#run(['cat-file', 'blob', entry.object], undefined, undefined, this.root, this.#objects, fd);
            // A file the turn deleted comes back as a new file would be made.
            const permissions = states.get(file)?.permissions ?? 0o666 & ~process.umask();
            fs.fchmodSync(fd, (permissions & 0o666) | (entry.mode === '100755' ? 0o111 : 0));
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
        }
        this.#flags(file, true);
        const currentParent = fs.lstatSync(parent);
        if (fs.realpathSync(parent) !== parent || currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino
          || (this.#state(file)?.fingerprint ?? null) !== (states.get(file)?.fingerprint ?? null)) throw Error(`checkpoint-content-changed: ${file}`);
        fs.renameSync(temporary, target); changed++;
      } finally { fs.rmSync(temporary, { force: true }); }
    } } catch (error) { throw changed ? Error(`checkpoint-partial: ${(error as Error).message}`) : error; }
  }
  // Folders the turn created and its undo emptied go too; a folder that held
  // files before the turn, or holds anything now, stays.
  #prune(file: string, before: Map<string, TreeEntry>) {
    const parts = file.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const folder = parts.slice(0, i).join('/');
      if ([...before.keys()].some(entry => entry.startsWith(folder + '/'))) return;
      try { fs.rmdirSync(path.join(this.root, folder)); } catch { return; }
    }
  }
  // Only the ref manager receives this plumbing port; it never accepts shell.
  readonly refsExecutor = { run: (args: string[], input?: Buffer) => {
    if (!this.#top() || !['for-each-ref', 'update-ref'].includes(args[0] ?? '')) throw Error('checkpoint-ref-command-invalid');
    return this.#run(args, input).toString('utf8');
  } };
}
