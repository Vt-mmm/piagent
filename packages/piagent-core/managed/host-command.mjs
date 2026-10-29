import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { redactedText } from '../runtime/managed-failure.mjs';
import { commandSegments, stripWrapper } from '../runtime/policy/handoff-policy.mjs';

// Commands the member approved to run on their machine, outside the sandbox
// (run_on_host, start_docker): installing a runtime the project needs, git
// with the member's own sign-in, a file outside the project (owner,
// 2026-10-13: once the member approves, it runs; only what needs the member
// themselves goes back to them).

// What only the member can do: type their password, sign in interactively.
const PASSWORD = new Set(['sudo', 'doas', 'su', 'pkexec', 'passwd']);
const SIGN_IN = [/^gh auth (login|refresh)\b/, /^(npm|pnpm) (login|adduser)\b/, /^yarn npm login\b/, /^docker login\b(?!.*--password-stdin)/, /^az login\b/,
  /^gcloud auth (login|application-default login)\b/, /^aws (configure\s*$|sso login\b)/, /^(firebase|vercel|wrangler|heroku|netlify) login\b/];
// Read through the shared shell parser (policy-core.js): `(sudo ls)`,
// `echo x & sudo ls` and `if …; then sudo …` are each a sudo.
export function memberOnlyReason(command) {
  for (const { words } of commandSegments(command)) {
    const run = stripWrapper(words), prefix = words.slice(0, words.length - run.length).map(word => word.split('/').pop());
    const elevated = prefix.find(word => PASSWORD.has(word));
    if (elevated) return `${elevated} needs the member's password`;
    const name = run[0], rest = run.join(' ');
    if (PASSWORD.has(name)) return `${name} needs the member's password`;
    if (name === 'installer' || name === 'softwareupdate') return `${name} needs the member's password`;
    if (SIGN_IN.some(rule => rule.test(rest))) return 'an interactive sign-in needs the member';
  }
  return null;
}
// Where credentials live on the member's machine. A command that names one
// reads or moves secrets, so it is asked about even in Bypass. A text check,
// not a boundary: it catches the usual spellings (~/.ssh, $HOME/.ssh,
// /Users/me/.ssh, `tar -C ~ .ssh`); the sandbox is what keeps secrets out of
// plain bash. Folders whose names projects also use (.docker, .pi) count only
// under a home directory.
const HOME = String.raw`(?:~|\$HOME|\$\{HOME\}|/Users/[^/\s'"]+|/home/[^/\s'"]+|/root)/`;
const CREDENTIALS = [/(^|[\s'"=:/])\.(ssh|aws|gnupg|kube|azure|npmrc|netrc|pypirc|git-credentials)(\b|\/|$)/, new RegExp(String.raw`${HOME}\.(docker|pi|codex|claude|piagent|config/gh|config/gcloud)\b`),
  /(^|[\s'"/])\.env(\.[\w-]+)?\b/, /\bauth\.json\b/, /\bcredentials(\.json)?\b/, /\bid_(rsa|ed25519|ecdsa|dsa)\b/, /\.(pem|p12|pfx|key)\b/,
  /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/, /Library\/Keychains\b/, /\bprintenv\b|(^|[;&|]\s*)env\s*($|[|;&>])/];
export function credentialReason(command) {
  const text = String(command ?? '');
  return CREDENTIALS.some(rule => rule.test(text)) ? 'the command reaches credentials (keys, tokens, Keychain or environment)' : null;
}
// What a command printed when it stopped to ask for a password or a terminal.
export const NEEDS_MEMBER = /sudo: a (terminal|password) is required|no tty present|askpass|Password:\s*$|must be run from a terminal|Inappropriate ioctl for device/im;

export const MEMBER_ONLY = reason => `managed-host-member-only: ${reason}. Lệnh này member phải tự làm (nhập mật khẩu máy hoặc đăng nhập tương tác). Dùng ask_user: đưa đúng lệnh hoặc các bước, nói vì sao cần, kèm lựa chọn "Tôi đã làm xong" và "Bỏ qua bước này"; member trả lời xong thì kiểm tra lại và làm tiếp.`;

const TAIL = 50 * 1024;
const tail = text => text.length > TAIL ? `[… ${text.length - TAIL} characters before …]\n${text.slice(-TAIL)}` : text;
const shell = () => process.platform === 'darwin' ? '/bin/zsh' : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';

// Runs one command as the member, in a login shell (Homebrew, SDKMAN… on
// PATH as in their Terminal). Nothing of Piagent's own environment (Studio
// tokens) is passed; no input, so a prompt ends the command instead of hanging.
export function runHostCommand({ command, cwd, userHome = os.homedir(), timeout = 600, signal, onUpdate, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('Command aborted'));
    const login = shell(), user = os.userInfo().username;
    const child = spawnImpl(login, ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: userHome, USER: user, LOGNAME: user, SHELL: login, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TERM: 'dumb',
        GIT_TERMINAL_PROMPT: '0', NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1', DEBIAN_FRONTEND: 'noninteractive' } });
    let output = '', ended = null, last = 0;
    const kill = why => { ended ??= why; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref(); };
    const seconds = Math.min(Math.max(Number(timeout) || 600, 1), 1800);
    const timer = setTimeout(() => kill(`Command timed out after ${seconds} seconds`), seconds * 1000); timer.unref();
    const abort = () => kill('Command aborted'); signal?.addEventListener('abort', abort, { once: true });
    const take = chunk => {
      output += chunk; if (output.length > 4 * TAIL) output = output.slice(-2 * TAIL);
      if (onUpdate && Date.now() - last > 250) { last = Date.now(); onUpdate({ content: [{ type: 'text', text: redactedText(tail(output)) }], details: { host: true } }); }
    };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', () => { ended ??= 'managed-host-command-failed: the shell did not start'; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const text = redactedText(tail(output.trimEnd()));
      if (ended) return reject(Error(`${text}${text ? '\n\n' : ''}${ended}`));
      if (code === 0) return resolve({ content: [{ type: 'text', text: text || '(no output)' }], details: { host: true, exitCode: 0 } });
      const member = NEEDS_MEMBER.test(output) ? `\n\n${MEMBER_ONLY('the command stopped to ask for a password or a terminal')}` : '';
      reject(Error(`${text}${member}\n\nCommand exited with code ${code}`));
    });
  });
}
