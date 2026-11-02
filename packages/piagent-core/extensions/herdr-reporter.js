import net from 'node:net';

// Herdr (herdr.dev) keeps panes of agents and resumes each one's session after
// its server restarts. Its own Pi extension lives in ~/.pi/agent/extensions,
// which a company conversation never loads, and `piagent studio` starts from a
// clean environment, so Herdr would see no state and resume nothing. This is
// the company Terminal's own reporter: the same socket requests (newline JSON,
// pane.report_agent), with the command that reopens this conversation in
// `piagent studio` instead of personal Pi.
const COMPANY_SOURCE = 'custom:piagent-studio', AGENT = 'piagent';

// What a Herdr pane gives its processes, read before the environment is
// cleared; null outside Herdr. Nothing else of it reaches the conversation.
export function herdrEnvironment(environment = process.env) {
  const socket = environment.HERDR_SOCKET_PATH, pane = environment.HERDR_PANE_ID;
  if (environment.HERDR_ENV !== '1' || !socket || !pane) return null;
  return { socket: process.platform === 'win32' ? `\\\\.\\pipe\\${socket}` : socket, pane };
}

// Herdr types this into the restored pane's shell. It refuses apostrophes and
// control characters (its POSIX quoting), so such a path is not offered.
export function herdrResumeArgv(cwd, sessionFile) {
  const argv = ['piagent', 'studio', '--project', cwd, ...(sessionFile ? ['--session', sessionFile] : [])];
  return safeArgv(argv);
}

// One request, delivered when Herdr answers; a second, longer try when the
// first is lost. A Herdr that is gone costs the conversation nothing.
function sendOnce(socketPath, request, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const socket = net.createConnection(socketPath);
    const finish = delivered => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(delivered); };
    const timer = setTimeout(() => finish(false), timeoutMs); timer.unref?.();
    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', () => finish(true));
    socket.on('end', () => finish(false));
  });
}
export async function sendHerdrRequest(socketPath, request) {
  if (!await sendOnce(socketPath, request, 500)) await sendOnce(socketPath, request, 1500);
}

// Herdr refuses a resume command with an apostrophe or control characters.
const safeArgv = argv => argv && argv.every(part => typeof part === 'string' && part && !part.includes("'") && !/\p{Cc}/u.test(part)) ? argv : null;

// working while a turn runs, blocked while the conversation waits for the
// member (Pi's blocking dialogs, or `herdr:blocked` events), idle otherwise.
// Reports go out one at a time, the newest state winning.
export function herdrReporterExtension(herdr, { source, resume, managed = null, send = sendHerdrRequest }) {
  return (pi) => {
    let unsubscribe, seq = Date.now() * 1000, active = false, blocked = 0, label, last, resumeArgv, queued, sending = false;
    const desired = () => blocked > 0 ? { state: 'blocked', message: label } : { state: active ? 'working' : 'idle', message: undefined };
    const drain = async () => {
      if (sending) return;
      sending = true;
      try {
        while (queued) {
          const next = queued; queued = undefined;
          await send(herdr.socket, { id: `${source}:${next.seq}`, method: 'pane.report_agent',
            params: { pane_id: herdr.pane, source, agent: AGENT, state: next.state, message: next.message, seq: next.seq, ...(resumeArgv ? { resume_argv: resumeArgv } : {}) } });
        }
      } finally { sending = false; if (queued) void drain(); }
    };
    const publish = (force = false) => {
      const next = desired();
      if (!force && next.state === last?.state && next.message === last?.message) return;
      last = next; queued = { ...next, seq: ++seq }; void drain();
    };
    const follow = ctx => {
      let file;
      try { file = ctx?.sessionManager?.getSessionFile?.(); } catch { file = undefined; }
      const argv = safeArgv(resume(ctx?.cwd, typeof file === 'string' && file ? file : undefined));
      const changed = JSON.stringify(argv) !== JSON.stringify(resumeArgv);
      resumeArgv = argv ?? undefined;
      return changed;
    };
    const wait = data => {
      if (data?.active) { blocked += 1; label = data.label; } else { blocked = Math.max(0, blocked - 1); if (!blocked) label = undefined; }
      publish();
    };
    pi.events?.on?.('herdr:blocked', wait);
    // A long list as a title is not a label Herdr can show.
    pi.on('ui_prompt_start', event => wait({ active: true, label: event?.title?.slice(0, 80) }));
    pi.on('ui_prompt_end', () => wait({ active: false }));
    // /new, /resume and /fork start another session: Herdr follows it.
    pi.on('session_start', async (_event, ctx) => {
      follow(ctx); active = ctx?.isIdle?.() === false || !!managed?.()?.activePrompt; publish(true);
      // One company message is many rounds: it is idle when the turn itself ends.
      unsubscribe?.();
      unsubscribe = managed?.()?.session?.subscribe?.(event => { if (event?.type === 'agent_settled' && !managed()?.activePrompt) { active = false; publish(); } });
    });
    pi.on('agent_start', (_event, ctx) => { const changed = follow(ctx); active = true; publish(changed); });
    pi.on('agent_settled', (_event, ctx) => { if (ctx?.isIdle?.() !== true || managed?.()?.activePrompt) return; active = false; publish(); });
  };
}

export function companyHerdrExtension(herdr, { send, managed } = {}) {
  return herdrReporterExtension(herdr, { source: COMPANY_SOURCE, resume: herdrResumeArgv, managed, ...(send ? { send } : {}) });
}
