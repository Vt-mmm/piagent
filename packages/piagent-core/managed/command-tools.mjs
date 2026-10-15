import { spawn } from 'node:child_process';
import { networkConfirmation } from './permission.mjs';
import { engineAlive, engineLauncher } from './container-engine.mjs';
import { MEMBER_ONLY, memberOnlyReason, runHostCommand } from './host-command.mjs';
import { processTools } from './background-process.mjs';
import { checkpointsOf } from './checkpoints.mjs';

// Commands that leave the plain sandbox, each after the member approves that
// exact command: run_with_network (internet, a local server or browser),
// run_with_docker when this machine has Docker (the same plus the engine's
// socket) and run_on_host (on the member's machine, outside the sandbox).
// Bypass runs the first two without asking (owner, 2026-10-09), except what
// must be confirmed for any command (bypass-policy.mjs: pushes, deploys,
// registry logins, deletes known only at run time); run_on_host always asks.
const PARAMETERS = { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 4000 }, reason: { type: 'string', minLength: 1, maxLength: 300 }, timeout: { type: 'number', minimum: 1, maximum: 1800 } }, required: ['command', 'reason'], additionalProperties: false };

const KINDS = {
  network: {
    name: 'run_with_network', label: 'Run with network', scope: 'network-command-once', provider: 'network', riskClass: 'medium',
    description: 'Run one shell command that needs the internet beyond the package registries bash already reaches (a download site or registry the package proxy refuses), or that starts a local server or a browser (end-to-end tests with Playwright\'s Chromium against a server on 127.0.0.1), after the user approves that exact command. Normal bash has no internet; on macOS it reaches servers on this Mac and runs Playwright\'s Chromium against them, except while a local proxy listens. Credentials (.npmrc, SSH keys, Keychain) stay unavailable, so private registries and git push are not possible here.',
    allow: 'Run this exact command once, with internet access; a server it starts accepts connections while it runs.',
    title: 'Chạy lệnh có internet', allowText: 'chạy đúng lệnh này một lần, có internet; server nó mở nhận kết nối trong lúc chạy.',
    confirm: (self, command) => networkConfirmation(self, command),
  },
  docker: {
    name: 'run_with_docker', label: 'Run with Docker', scope: 'docker-command-once', provider: 'docker', riskClass: 'high',
    description: 'Run one shell command that needs the Docker engine of this machine: docker, docker compose (a database or service for tests), docker build, or tests that start containers themselves (Testcontainers), after the user approves that exact command. It has internet access too. Normal bash and run_with_network cannot reach Docker. Mount only folders inside the project. Registry credentials are unavailable: public images pull, private registries and docker push do not. Containers started in the background (-d, compose up -d) keep running after the command: stop them (docker compose down) when the work is done unless the member wants them kept.',
    allow: 'Run this exact command once, with internet access and the Docker engine; a container it starts can read folders Docker shares from this machine and may keep running.',
    title: 'Chạy lệnh dùng Docker', allowText: 'chạy đúng lệnh này một lần, có internet và Docker; container nó tạo có thể đọc thư mục Docker được chia sẻ trên máy và có thể tiếp tục chạy.',
    confirm: (self, command) => networkConfirmation(self, command),
  },
  host: {
    name: 'run_on_host', label: 'Run on this machine', scope: 'host-command-once', provider: 'host', riskClass: 'high',
    description: 'Run one shell command on the member\'s machine, outside the sandbox, as the member, after they approve that exact command. Use it when the sandbox blocks what the task needs and no other tool covers it: install a runtime or tool the project needs (brew install openjdk@21, brew install node@22, sdk install java…), git pull or git push with the member\'s sign-in, a private registry, a file outside the project. It has the member\'s files, Keychain and sign-ins, so ask only for what the task needs and say why in reason. No input can be typed: commands that need the member\'s password (sudo, a .pkg installer) or an interactive sign-in are refused; ask the member with ask_user for those.',
    allow: 'Run this exact command once on this machine, outside the sandbox, as you: it can read and change your files and use your sign-ins.',
    title: 'Chạy lệnh trên máy (ngoài sandbox)', allowText: 'chạy đúng lệnh này một lần trên máy bạn, ngoài sandbox, bằng quyền của bạn: lệnh đọc/sửa được file và dùng được tài khoản đã đăng nhập trên máy.',
    // Bypass does not cover it: the member approves each command (with what
    // Bypass would still have asked about, when there is something).
    confirm: async (self, command) => await networkConfirmation(self, command) ?? 'ask',
  },
};

// The engine answers, looked up again when it did not (started since).
async function engineReady(boundary) {
  if (boundary.engine && await engineAlive(boundary.engine.socket)) return true;
  return boundary.refreshEnvironment() && engineAlive(boundary.engine.socket);
}
const DOCKER_STOPPED = 'managed-docker-unreachable: Docker engine trên máy không chạy. Gọi start_docker để xin member duyệt mở Docker, rồi chạy lại đúng lệnh này bằng run_with_docker.';

// One approval of the member (the dashboard card, else the Terminal).
async function approve(self, id, signal, ctx, action, { title, body }) {
  const { piApprovalBroker } = await import('../runtime/inspection/approval-broker.ts');
  const decision = await piApprovalBroker.request({ cwd: self.cwd, rawSessionId: self.session.sessionManager.getSessionId(), toolCallId: id,
    action: { kind: 'external-provider-action', preconditionClass: 'runtime-only', targetPaths: [self.cwd], urlOrigin: null, ...action },
    terminalConfirm: () => ctx?.ui?.confirm?.(title, body) ?? Promise.resolve(false),
    unavailableFallback: 'terminal-confirm', recheck: () => !signal?.aborted && Boolean(self.grant) });
  if (!decision.allowed || !decision.consume() || signal?.aborted) throw Error('managed-operation-denied');
}

function commandTool(self, kind) {
  const spec = KINDS[kind];
  return { name: spec.name, label: spec.label, description: spec.description, parameters: PARAMETERS,
    execute: async (id, args, signal, onUpdate, ctx) => {
      if (kind === 'docker' && !await engineReady(self.boundary)) throw Error(DOCKER_STOPPED);
      const memberOnly = kind === 'host' ? memberOnlyReason(args.command) : null;
      if (memberOnly) throw Error(MEMBER_ONLY(memberOnly));
      const confirm = await spec.confirm(self, args.command);
      if (confirm !== null) await approve(self, id, signal, ctx, { toolName: spec.name, rawAction: { command: args.command }, commandPreview: String(args.command),
        provider: spec.provider, requestedScope: spec.scope, reason: (confirm === 'ask' ? String(args.reason) : `Bypass still asks: ${confirm}. ${args.reason}`).slice(0, 300), riskClass: spec.riskClass,
        allowConsequence: spec.allow, denyConsequence: 'The command does not run; the agent is told you declined.' },
      { title: spec.title, body: `${args.command}\n\nLý do: ${args.reason}${confirm === 'ask' ? '' : `\nBypass vẫn hỏi: ${confirm}`}\n\nĐồng ý: ${spec.allowText}\nTừ chối: lệnh không chạy, agent được báo bạn đã từ chối.` });
      let ok = false;
      if (self.run) await checkpointsOf(self).take();
      const before = await self.changedFiles();
      try {
        const result = kind === 'host' ? await runHostCommand({ command: args.command, cwd: self.cwd, userHome: self.boundary.userHome, timeout: args.timeout, signal, onUpdate })
          : await self.boundary.invoke('bash', { command: args.command, ...(args.timeout ? { timeout: args.timeout } : {}) }, signal, onUpdate, ctx?.model, kind === 'docker' ? { docker: true } : { network: true });
        ok = !result?.isError; return result;
      } finally {
        // What the command installed (a JDK, Node) is there for the next one.
        if (kind === 'host') self.boundary.refreshEnvironment();
        await self.claimChanges(before); await self.run?.afterTool('bash', args, ok, () => self.digest()); await self.refreshReview();
      }
    } };
}

// start_docker: the engine the member installed, started after they approve
// (Bypass starts it without asking: local and reversible), then waited for.
const textResult = text => ({ content: [{ type: 'text', text }], details: {} });
function startDockerTool(self, { wait = 180_000, every = 2000, launcher: found = engineLauncher, spawnImpl = spawn } = {}) {
  return { name: 'start_docker', label: 'Start Docker',
    description: 'Start the Docker engine installed on this machine (Docker Desktop, OrbStack, Colima, rootless Docker) after the member approves, and wait until it answers; run_with_docker works right after, in this conversation. Use it when a command reports that Docker is not running.',
    parameters: { type: 'object', properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } }, required: ['reason'], additionalProperties: false },
    execute: async (id, args, signal, _onUpdate, ctx) => {
      if (await engineReady(self.boundary)) return textResult('The Docker engine is running: use run_with_docker.');
      const launcher = found({ userHome: self.boundary.userHome });
      if (!launcher) throw Error(self.boundary.dockerCli ? MEMBER_ONLY("starting this machine's Docker service needs the member's password")
        : 'managed-docker-not-installed: Máy chưa cài Docker. Hỏi member bằng ask_user: cài Docker Desktop hoặc OrbStack (trình cài cần mật khẩu nên member tự cài; máy có Homebrew thì có thể xin run_on_host "brew install colima docker"), hay chạy check theo cách khác.');
      const preview = `${launcher.command} ${launcher.args.join(' ')}`;
      if (self.permission !== 'trusted-full-access') await approve(self, id, signal, ctx, { toolName: 'start_docker', rawAction: { launcher: launcher.label }, commandPreview: preview,
        provider: 'docker', requestedScope: 'start-docker-once', reason: String(args.reason).slice(0, 300), riskClass: 'medium',
        allowConsequence: `Start ${launcher.label} on this machine; it keeps running after the conversation.`, denyConsequence: 'Docker is not started; the agent is told you declined.' },
      { title: `Mở ${launcher.label}`, body: `${preview}\n\nLý do: ${args.reason}\n\nĐồng ý: mở ${launcher.label} trên máy; nó vẫn chạy sau cuộc trò chuyện.\nTừ chối: không mở Docker, agent được báo bạn đã từ chối.` });
      try { spawnImpl(launcher.command, launcher.args, { detached: true, stdio: 'ignore', env: { HOME: self.boundary.userHome, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', USER: process.env.USER ?? '', LANG: 'en_US.UTF-8' } }).on('error', () => {}).unref(); } catch { /* waited for below */ }
      for (const until = Date.now() + wait; Date.now() < until;) {
        if (signal?.aborted) throw Error('managed-tool-cancelled');
        await new Promise(resolve => setTimeout(resolve, every));
        if (await engineReady(self.boundary)) return textResult(`${launcher.label} is running. Run the Docker command again with run_with_docker.`);
      }
      throw Error(`managed-docker-start-timeout: ${launcher.label} đã được mở nhưng engine chưa trả lời sau ${Math.round(wait / 60000)} phút (lần đầu mở app có thể chờ member bấm đồng ý điều khoản hoặc đăng nhập trong cửa sổ Docker). Hỏi member bằng ask_user, kèm lựa chọn "Docker đã chạy, thử lại" và "Bỏ qua bước này".`);
    } };
}

export function commandTools(self, options) {
  const docker = self.boundary.engine || self.boundary.dockerCli;
  return [commandTool(self, 'network'), ...(docker ? [commandTool(self, 'docker')] : []), startDockerTool(self, options), commandTool(self, 'host'), ...processTools(self)];
}

// What the system prompt says about services and what the sandbox blocks: it
// is read for every request, so a Docker started since shows up.
const HOST_PROMPT = ' When the sandbox blocks something the task needs (a missing runtime such as a JDK or a Node version, the member\'s sign-in for git pull or git push or a private registry, a file outside the project), do not stop and do not tell the member to run it: request run_on_host with the exact command; it runs on the member\'s machine once they approve. Only what needs the member themselves (their password for sudo or an installer, an interactive sign-in, a window to click) goes to ask_user, with the exact steps and the options to continue or skip; after their answer, check and carry on.';
export function servicesPrompt(boundary) {
  const simulator = ' The iOS Simulator is not available in the sandbox: ask the member with ask_user to run those tests.';
  if (boundary.engine) return ' Docker is available through run_with_docker (the member approves each command): a database or service for tests (docker compose up -d, then the tests through bash or run_with_network), docker build, or Testcontainers tests. If the engine stops answering, start_docker asks the member to start it. Stop what you started when done unless the member wants it kept.' + simulator + HOST_PROMPT;
  if (boundary.dockerCli) return ' Docker is installed but not running: when the task needs it, call start_docker (the member approves), then run_with_docker.' + simulator + HOST_PROMPT;
  return ' Docker is not installed on this machine: when the task needs it, ask the member with ask_user (install it, or check another way).' + simulator + HOST_PROMPT;
}
