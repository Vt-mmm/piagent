import { mustConfirm } from '../runtime/policy/bypass-policy.mjs';
import { dockerConfirmation } from './container-engine.mjs';
import { networkConfirmation } from './permission.mjs';

// Commands that leave the plain sandbox, each after the member approves that
// exact command: run_with_network (internet, a local server or browser) and,
// when this machine has a Docker engine, run_with_docker (the same plus the
// engine's socket). Bypass runs them without asking, except what must be
// confirmed: for Docker also a container given host folders outside the
// project, the engine's socket, or the host's processes or network.
const PARAMETERS = { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 4000 }, reason: { type: 'string', minLength: 1, maxLength: 300 }, timeout: { type: 'number', minimum: 1, maximum: 1800 } }, required: ['command', 'reason'], additionalProperties: false };

const KINDS = {
  network: {
    name: 'run_with_network', label: 'Run with network', scope: 'network-command-once', provider: 'network', riskClass: 'medium',
    description: 'Run one shell command that needs the internet (package install, download, git pull of a public repository), or that starts a local server or a browser (end-to-end tests with Playwright\'s Chromium against a server on 127.0.0.1), after the user approves that exact command. Normal bash has no network and cannot listen on a port. Credentials (.npmrc, SSH keys, Keychain) stay unavailable, so private registries and git push are not possible here.',
    allow: 'Run this exact command once, with internet access; a server it starts accepts connections while it runs.',
    title: 'Chạy lệnh có internet', allowText: 'chạy đúng lệnh này một lần, có internet; server nó mở nhận kết nối trong lúc chạy.',
    confirm: (self, command) => networkConfirmation(self, command),
  },
  docker: {
    name: 'run_with_docker', label: 'Run with Docker', scope: 'docker-command-once', provider: 'docker', riskClass: 'high',
    description: 'Run one shell command that needs the Docker engine of this machine: docker, docker compose (a database or service for tests), docker build, or tests that start containers themselves (Testcontainers), after the user approves that exact command. It has internet access too. Normal bash and run_with_network cannot reach Docker. Mount only folders inside the project. Registry credentials are unavailable: public images pull, private registries and docker push do not. Containers started in the background (-d, compose up -d) keep running after the command: stop them (docker compose down) when the work is done unless the member wants them kept.',
    allow: 'Run this exact command once, with internet access and the Docker engine; a container it starts can read folders Docker shares from this machine and may keep running.',
    title: 'Chạy lệnh dùng Docker', allowText: 'chạy đúng lệnh này một lần, có internet và Docker; container nó tạo có thể đọc thư mục Docker được chia sẻ trên máy và có thể tiếp tục chạy.',
    confirm: async (self, command) => self.permission !== 'trusted-full-access' ? 'ask'
      : await mustConfirm(command) ?? dockerConfirmation(command, { cwd: self.cwd, home: self.boundary.userHome }),
  },
};

function commandTool(self, kind) {
  const spec = KINDS[kind];
  return { name: spec.name, label: spec.label, description: spec.description, parameters: PARAMETERS,
    execute: async (id, args, signal, onUpdate, ctx) => {
      const confirm = await spec.confirm(self, args.command);
      const decision = confirm === null ? { allowed: true, consume: () => true } : await (await import('../runtime/inspection/approval-broker.ts')).piApprovalBroker.request({ cwd: self.cwd, rawSessionId: self.session.sessionManager.getSessionId(), toolCallId: id,
        action: { kind: 'external-provider-action', preconditionClass: 'runtime-only', toolName: spec.name, rawAction: { command: args.command }, commandPreview: String(args.command),
          targetPaths: [self.cwd], provider: spec.provider, urlOrigin: null, requestedScope: spec.scope, reason: (confirm === 'ask' ? String(args.reason) : `Bypass still asks: ${confirm}. ${args.reason}`).slice(0, 300), riskClass: spec.riskClass,
          allowConsequence: spec.allow, denyConsequence: 'The command does not run; the agent is told you declined.' },
        terminalConfirm: () => ctx?.ui?.confirm?.(spec.title, `${args.command}\n\nLý do: ${args.reason}${confirm === 'ask' ? '' : `\nBypass vẫn hỏi: ${confirm}`}\n\nĐồng ý: ${spec.allowText}\nTừ chối: lệnh không chạy, agent được báo bạn đã từ chối.`) ?? Promise.resolve(false),
        unavailableFallback: 'terminal-confirm', recheck: () => !signal?.aborted && Boolean(self.grant) });
      if (!decision.allowed || !decision.consume() || signal?.aborted) throw Error('managed-operation-denied');
      let ok = false;
      const before = await self.changedFiles();
      try { const result = await self.boundary.invoke('bash', { command: args.command, ...(args.timeout ? { timeout: args.timeout } : {}) }, signal, onUpdate, ctx?.model, kind === 'docker' ? { docker: true } : { network: true }); ok = !result?.isError; return result; }
      finally { await self.claimChanges(before); await self.run?.afterTool('bash', args, ok, () => self.digest()); await self.refreshReview(); }
    } };
}

export function commandTools(self) {
  return [commandTool(self, 'network'), ...(self.boundary.engine ? [commandTool(self, 'docker')] : [])];
}

// What the system prompt says about services: Docker when the machine has an
// engine (run_with_docker), else the member starts them.
export function servicesPrompt(boundary) {
  if (boundary.engine) return ' Docker is available through run_with_docker (the member approves each command): a database or service for tests (docker compose up -d, then the tests through bash or run_with_network), docker build, or Testcontainers tests. Stop what you started when done unless the member wants it kept. The iOS Simulator is not available in the sandbox: ask the member to run those tests.';
  return ' Docker is not running on this machine and the iOS Simulator is not available in the sandbox: ask the member to start those services (or Docker, after which a new conversation has run_with_docker) or run those tests.';
}
