// The company Terminal (`piagent studio`) says what the dashboard says: a new
// release is asked about, Bypass can be chosen, the Harness's notes and a
// failed request read in the member's words. Loaded only in the Terminal; the
// company Gateway draws its own pages.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { registerTerminalUpdateOffer } from '../packages/piagent-core/runtime/update/terminal-update-offer.mjs';
import { parseFailure } from '../packages/piagent-core/runtime/managed-failure.mjs';
import { checkpointsOf } from '../packages/piagent-core/managed/checkpoints.mjs';
import { memoryOn } from '../packages/piagent-core/managed/memory.mjs';
import { companyFailureText } from '../packages/piagent-webui/shared/company-copy.ts';
import { headlineText, outcomeText, processItems } from '../packages/piagent-webui/shared/process-copy.ts';
import { turnEndCopy, turnEndOf } from '../packages/piagent-webui/shared/turn-end.ts';

const LOCALE = 'vi';

const WORKING = 'Đang làm…';

// A typed value that is already complete offers nothing, so the first Enter runs the command.
export const argumentCompletions = (values) => (prefix) => {
  const typed = String(prefix ?? '').trim();
  return values.includes(typed) ? [] : values.filter((v) => v.startsWith(typed)).map((value) => ({ value, label: value }));
};

const compactTokens = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const textOf = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n') : '';

// Model requests, tokens, time and output speed of the member's last message,
// as the dashboard writes them under a turn.
export function turnStats(messages, now = Date.now()) {
  const list = Array.isArray(messages) ? messages : [];
  const start = list.findLastIndex((m) => m?.role === 'user');
  if (start < 0) return null;
  const answers = list.slice(start + 1).filter((m) => m?.role === 'assistant');
  if (!answers.length) return null;
  const tokens = answers.reduce((n, m) => n + (m.usage?.totalTokens ?? 0), 0), output = answers.reduce((n, m) => n + (m.usage?.output ?? 0), 0);
  const began = Number(list[start].timestamp) || null, seconds = began ? Math.max(0, Math.round((now - began) / 1000)) : null;
  const parts = [`${answers.length} request`];
  if (tokens) parts.push(`${compactTokens(tokens)} token`);
  if (seconds) parts.push(seconds < 60 ? `${seconds} giây` : `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`);
  if (seconds && output) parts.push(`${Math.round(output / seconds)} tok/s`);
  return parts.join(' · ');
}

// Team memory results stay short in the transcript (Ctrl+O shows all).
export function memoryResultLines(text, expanded = false) {
  const lines = String(text ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  if (expanded || lines.length <= 4) return lines;
  const facts = lines.filter((l) => /^\s*-\s/.test(l)).length;
  return [...lines.slice(0, 3), `… ${facts ? `${facts} ghi chú, ` : ''}${lines.length - 3} dòng nữa (Ctrl+O để xem hết)`];
}

const branchOf = (cwd) => new Promise((resolve) => execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000 },
  (error, out) => resolve(error ? null : String(out).trim() || null)));
export const HELP_TEXT = [
  'Cuộc trò chuyện công ty: /undo hoàn tác file lượt trước đã sửa · /bypass on|off|status quyền lệnh cần internet · /fast on|off|status (khi Harness cho phép) · /skill:<tên> hoặc /<lệnh> của bạn và của project.',
  'Pi: /session thông tin cuộc trò chuyện · /resume mở cuộc trò chuyện công ty khác · /new cuộc mới · /compact nén ngữ cảnh · /tree, /fork nhánh · /name đặt tên · /copy, /export · /hotkeys toàn bộ phím tắt · /quit thoát.',
  'Phím: ! <lệnh> chạy shell · Esc dừng lượt đang chạy · Ctrl+C xoá ô nhập, hai lần để thoát · Ctrl+O xem thêm.',
  'Mở lại sau: piagent studio --project <thư mục>, rồi /resume. Đừng mở cuộc trò chuyện công ty bằng pi cá nhân.',
].join('\n');
const PERMISSION_STATUS = 'agent-watch-permission';
const ASK = 'Hỏi trước (mặc định)', BYPASS = 'Bypass: chỉ hỏi việc bắt buộc';
const PERMISSION_TEXT = {
  'workspace-write': 'Hỏi trước: mọi lệnh cần internet đều hỏi bạn.',
  'trusted-full-access': 'Bypass: lệnh cần internet chạy luôn; vẫn hỏi trước khi đẩy hoặc gửi dữ liệu ra ngoài, chạy migration, xoá không rõ đích hoặc dùng sudo.',
};

const EFFORT = { off: 'Tắt', minimal: 'Tối thiểu', low: 'Thấp', medium: 'Trung bình', high: 'Cao', xhigh: 'Rất cao', max: 'Tối đa' };
export const effortText = (level) => EFFORT[level] ?? level ?? '';

// What the team's Harness decides for this conversation, as the header and
// footer say it: roles and effort only. A member never sees which model a
// role runs on, so no model id leaves this function. `last` is the main
// agent's latest run (its effort); before the first run, the Harness's effort.
export function harnessSummary(managed, { last = null, version = null } = {}) {
  const manifest = managed?.manifest, config = manifest?.harness?.configuration ?? {};
  const review = config.workflow?.review !== 'off' && Boolean(config.review?.model_ids?.length);
  const fast = managed?.session?.managedFastState?.() ?? null;
  return {
    team: manifest?.user?.team_name || null,
    effort: last?.effort || config.main?.effort || managed?.session?.state?.thinkingLevel || null,
    review, permission: managed?.permission === 'trusted-full-access' ? 'Bypass' : 'Hỏi trước',
    fast: fast === null ? null : fast === 'on', memory: managed ? memoryOn(managed) : false, version,
  };
}
export function headerText(summary) {
  return ['Piagent công ty', summary.team && `team ${summary.team}`,
    `Main agent${summary.effort ? ` (${effortText(summary.effort)})` : ''}`,
    summary.review && 'Subagent review bật', summary.permission,
    summary.fast !== null && `Fast ${summary.fast ? 'bật' : 'tắt'}`, `memory ${summary.memory ? 'bật' : 'tắt'}`, summary.version].filter(Boolean).join(' · ');
}
export const HEADER_KEYS = 'Esc dừng lượt · Ctrl+C xoá ô nhập, hai lần để thoát · / lệnh · ! shell · Ctrl+O xem thêm · /help';

// Pi's own commands that the company Terminal answers itself. /share and
// /bug would send the conversation and code outside the company; the others
// pick what the team's Harness decides. Keys that do the same (Ctrl+L,
// Ctrl+P, Shift+Tab) answer the same.
const ADMIN = 'Admin đổi trong Agent Studio → Harness.';
export function companyCommandText(name, summary = {}) {
  const main = summary.effort ? ` (Main agent: ${effortText(summary.effort)})` : '';
  switch (name) {
    case 'share': return '/share bị tắt trong cuộc trò chuyện công ty: lệnh này đăng toàn bộ hội thoại lên GitHub Gist, ra ngoài công ty. Cần lưu lại thì dùng /export (file trên máy này).';
    case 'bug': return '/bug bị tắt trong cuộc trò chuyện công ty: báo cáo gửi hội thoại và code cho nhà phát triển Pi, ra ngoài công ty. Gặp lỗi, gửi admin của team mã lỗi trong [ ] và giờ xảy ra.';
    case 'login': case 'logout': return 'Cuộc trò chuyện công ty dùng tài khoản AI của team qua Agent Watch: không cần /login hay /logout. Tài khoản và API key cá nhân chỉ dùng trong pi cá nhân.';
    case 'model': case 'scoped-models': return `Model do Harness của team quyết định${main}; Terminal không chọn model. ${ADMIN}`;
    case 'thinking': return `Mức suy luận do Harness của team quyết định${main}. ${ADMIN}`;
    case 'settings': return `Cài đặt của cuộc trò chuyện công ty (compaction, retry…) do Harness quyết định. Phím tắt: /hotkeys. ${ADMIN}`;
    default: return null;
  }
}
// Pi's commands in the / suggestions say what they do here. They stay listed:
// with one hidden, Enter on "/bug" would pick the nearest other match (a
// skill) and send it to the agent.
const SUGGESTION_TEXT = { share: 'Tắt trong cuộc trò chuyện công ty', bug: 'Tắt trong cuộc trò chuyện công ty',
  login: 'Không dùng: tài khoản của team qua Agent Watch', logout: 'Không dùng: tài khoản của team qua Agent Watch',
  model: 'Harness của team quyết định model', 'scoped-models': 'Harness của team quyết định model',
  thinking: 'Harness của team quyết định mức suy luận', settings: 'Harness của team quyết định', changelog: 'Có gì mới trong Piagent' };
export function companySuggestions(suggestions) {
  if (!suggestions?.items || !String(suggestions.prefix ?? '').startsWith('/')) return suggestions;
  return { ...suggestions, items: suggestions.items.map((item) => {
    const text = SUGGESTION_TEXT[String(item.value ?? '').replace(/^\//, '').trim()];
    return text ? { ...item, description: text } : item;
  }) };
}

// /changelog: the newest Piagent releases from the installed CHANGELOG.md.
export function whatsNewMarkdown(changelog, count = 3) {
  const sections = String(changelog ?? '').split(/^(?=## v\d)/m).filter((part) => part.startsWith('## v')).slice(0, count);
  return sections.length ? sections.map((part) => part.trim()).join('\n\n') : 'Chưa có ghi chú phát hành.';
}

// The plan as a checklist, as the dashboard's Plan card shows it.
export function planLines(plan) {
  const steps = Array.isArray(plan) ? plan : [];
  const mark = { completed: '☑', in_progress: '☐', deferred: '⊘', pending: '☐' };
  return [`Plan · ${steps.filter((p) => p.status === 'completed').length}/${steps.length} bước xong`,
    ...steps.map((p) => `  ${mark[p.status] ?? '☐'} ${p.step}${p.status === 'in_progress' ? '  ← đang làm' : p.status === 'deferred' ? '  (để sau)' : ''}`)];
}

// A harness note's details, in the shape the shared copy reads.
export function processInput(details) {
  if (!details || typeof details !== 'object' || typeof details.phase !== 'string') return null;
  const { policy, ...rest } = details;
  return { ...rest, verifyPolicy: policy?.verify, reviewPolicy: policy?.review };
}

// The lines a harness note shows: what happened, then its findings or objections.
export function processLines(details) {
  const input = processInput(details);
  if (!input) return null;
  const head = input.phase === 'final' ? outcomeText(input, LOCALE) : headlineText(input, LOCALE);
  if (!head) return null;
  const items = processItems(input, LOCALE).map((item, i) => `  ${i + 1}. [${item.tag}]${item.location ? ` ${item.location} —` : ''} ${item.text}`);
  return [input.phase === 'final' ? `Tiến trình: ${head}` : head, ...items];
}

// A failed company request, as the dashboard explains it (null when it is not one).
export function failureLines(errorMessage) {
  const failure = parseFailure(errorMessage);
  if (!failure) return null;
  const copy = companyFailureText(`company-${failure.kind}`, failure.code, LOCALE);
  return copy ? `${copy.title}: ${copy.text} [${failure.code}]` : null;
}

const tokens = (n) => n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`;
// Pi's footer without the USD cost (company accounts are not billed per
// conversation) and with the main agent's effort on the right (never its model).
export function footerLines({ session, summary, footerData, theme, width, truncateToWidth, visibleWidth }) {
  const dim = (text) => theme.fg('dim', text);
  if (!session) return [truncateToWidth(dim(headerText(summary)), width, dim('...'))];
  const home = process.env.HOME;
  let where = session.sessionManager.getCwd();
  if (home && (where === home || where.startsWith(home + '/'))) where = '~' + where.slice(home.length);
  const branch = footerData?.getGitBranch?.(), name = session.sessionManager.getSessionName?.();
  if (branch) where += ` (${branch})`;
  if (name) where += ` • ${name}`;
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of session.sessionManager.getEntries()) {
    const usage = entry.type === 'usage' ? entry.usage : entry.type === 'message' && ['assistant', 'toolResult'].includes(entry.message?.role) ? entry.message.usage : null;
    if (usage) for (const key of Object.keys(sum)) sum[key] += Number(usage[key]) || 0;
  }
  const context = session.getContextUsage?.(), window = context?.contextWindow ?? session.state?.model?.contextWindow ?? 0;
  const percent = context?.percent ?? 0, shown = context?.percent == null ? '?' : percent.toFixed(1);
  const parts = [sum.input && `↑${tokens(sum.input)}`, sum.output && `↓${tokens(sum.output)}`, sum.cacheRead && `R${tokens(sum.cacheRead)}`, sum.cacheWrite && `W${tokens(sum.cacheWrite)}`].filter(Boolean);
  const ctxText = `${shown === '?' ? '?' : shown + '%'}/${tokens(window)} (auto)`;
  let left = [...parts, ctxText].join(' ');
  const right = `Main agent${summary.effort ? ` • ${effortText(summary.effort)}` : ''}`;
  if (visibleWidth(left) > width) left = truncateToWidth(left, width, '...');
  const room = width - visibleWidth(left) - 2;
  const tail = room > 0 && right ? truncateToWidth(right, room, '') : '';
  const pad = tail ? ' '.repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(tail))) : '';
  const loud = percent > 90 ? 'error' : percent > 70 ? 'warning' : null;
  const stats = loud ? dim(left.slice(0, left.length - ctxText.length)) + theme.fg(loud, left.slice(left.length - ctxText.length)) : dim(left);
  const lines = [truncateToWidth(dim(where), width, dim('...')), stats + dim(pad + tail)];
  const statuses = footerData?.getExtensionStatuses?.();
  if (statuses?.size) lines.push(truncateToWidth([...statuses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => String(text).replace(/\s+/g, ' ').trim()).join(' '), width, dim('...')));
  return lines;
}

// The update_plan tool drawn as a checklist (set on the session's tool definition).
export async function companyToolRenderers(sdkRoot) {
  const require = createRequire(path.join(sdkRoot, 'package.json'));
  const { Text } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
  const memory = (title) => ({
    renderCall: (args, theme) => new Text(theme.fg('toolTitle', theme.bold(title)) + (args?.query || args?.name || args?.question ? theme.fg('muted', ` ${args.query ?? args.name ?? args.question}`) : ''), 0, 0),
    renderResult: (result, options, theme) => new Text(theme.fg('toolOutput', memoryResultLines((result?.content ?? []).map((c) => c.text ?? '').join('\n'), options?.expanded).join('\n')), 0, 0) });
  return { memory_search: memory('Team memory'), memory_page: memory('Trang kiến thức'), memory_ask: memory('Hỏi team memory'), update_plan: {
    renderCall: (_args, theme) => new Text(theme.fg('toolTitle', theme.bold('Plan')), 0, 0),
    renderResult: (result, _options, theme) => {
      const plan = result?.details?.plan;
      if (!Array.isArray(plan)) return new Text(theme.fg('toolOutput', (result?.content ?? []).map((c) => c.text ?? '').join('\n')), 0, 0);
      const [head, ...steps] = planLines(plan);
      return new Text([theme.fg('toolOutput', head), ...steps.map((line, i) => theme.fg(plan[i].status === 'completed' ? 'success' : plan[i].status === 'in_progress' ? 'accent' : 'muted', line))].join('\n'), 0, 0);
    } } };
}

// Pi's InteractiveMode for the company Terminal. Pi runs its own commands
// before an extension's (and shows its /bug hint after errors) with no hook
// for either, so the few it must not run are answered here.
export async function companyInteractiveMode(api, { sdkRoot, packageRoot, summary = () => ({}) }) {
  const require = createRequire(path.join(sdkRoot, 'package.json'));
  const { Markdown, Spacer } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
  const changelog = () => { try { return fs.readFileSync(path.join(packageRoot, 'CHANGELOG.md'), 'utf8'); } catch { return ''; } };
  return companyMode(api.InteractiveMode, { summary, whatsNew: () => whatsNewMarkdown(changelog()), components: { Markdown, Spacer, DynamicBorder: api.DynamicBorder } });
}
// Pi's own warnings, as the company Terminal says them: the crash notice
// without /bug, and no model id ("Could not restore model p/id").
export function companyWarning(message) {
  const text = String(message ?? '');
  const crash = /^\S+ crashed on (.+?) \((.*)\)\. Run \/bug/s.exec(text);
  if (crash) return `Lần trước Piagent công ty dừng bất thường (${crash[1]}, ${crash[2]}). Cuộc trò chuyện vẫn còn: /resume để mở lại. Nếu lặp lại, gửi admin của team giờ xảy ra.`;
  if (/^Could not restore model /.test(text)) return 'Cuộc trò chuyện này chạy theo Harness hiện tại của team.';
  return text;
}
export function companyMode(Base, { summary, whatsNew, components }) {
  const say = (mode, name, tone = 'warning') => mode.showExtensionNotify(companyCommandText(name, summary()), tone);
  return class CompanyInteractiveMode extends Base {
    async handleShareCommand() { say(this, 'share'); }
    async handleBugCommand() { say(this, 'bug'); }
    suggestBugReport() {}
    crashReportInstructions() { return 'Lần sau mở lại: piagent studio, rồi /resume. Gửi admin của team giờ xảy ra lỗi.'; }
    // Pi's start-up warnings point at /bug (off here) or name a model.
    showWarning(message) { super.showWarning(companyWarning(message)); }
    async handleLoginCommand() { say(this, 'login', 'info'); }
    async showOAuthSelector() { say(this, 'logout', 'info'); }
    async handleModelCommand() { say(this, 'model', 'info'); }
    showModelSelector() { say(this, 'model', 'info'); }
    showModelsSelector() { say(this, 'scoped-models', 'info'); }
    async cycleModel() { say(this, 'model', 'info'); }
    handleThinkingCommand() { say(this, 'thinking', 'info'); }
    cycleThinkingLevel() { say(this, 'thinking', 'info'); }
    showSettingsSelector() { say(this, 'settings', 'info'); }
    // Pi's own release notes are not Piagent's.
    getChangelogForDisplay() { return undefined; }
    handleChangelogCommand() {
      const { Markdown, Spacer, DynamicBorder } = components;
      this.chatContainer.addChild(new Spacer(1));
      if (DynamicBorder) this.chatContainer.addChild(new DynamicBorder());
      this.chatContainer.addChild(new Markdown(`# Có gì mới trong Piagent\n\n${whatsNew()}`, 1, 1, this.getMarkdownThemeWithSettings()));
      if (DynamicBorder) this.chatContainer.addChild(new DynamicBorder());
      this.ui.requestRender();
    }
  };
}

export function companyTerminalExtension({ managed, packageRoot, sdkRoot, bindingChanged = () => false }) {
  const require = createRequire(path.join(sdkRoot, 'package.json'));
  let tui;
  const components = async () => (tui ??= await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href));
  const installed = (() => { try { return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version; } catch { return undefined; } })();

  return async (pi) => {
    const { Box, Text } = await components();
    const box = (text, theme, color) => {
      const view = new Box(1, 0, (t) => theme.bg('customMessageBg', t));
      view.addChild(new Text(color ? theme.fg(color, text) : text, 0, 0));
      return view;
    };

    registerTerminalUpdateOffer(pi, { installed, packageRoot, restart: 'piagent studio',
      afterUpdate: () => bindingChanged() ? 'Bản mới đổi trình khởi chạy công ty: Agent Watch tự cập nhật cấu hình (cần Agent Watch đang chạy); piagent studio chờ việc này khi mở lại.' : null });

    // Ask first or Bypass, kept with the conversation like the dashboard's switch.
    const showPermission = (ctx) => ctx.ui?.setStatus?.(PERMISSION_STATUS, managed()?.permission === 'trusted-full-access' ? 'Bypass' : undefined);
    pi.on('session_start', async (_event, ctx) => showPermission(ctx));
    pi.registerCommand('bypass', {
      description: 'Bật/tắt Bypass cho cuộc trò chuyện công ty này (on, off, hoặc để trống để chọn)',
      getArgumentCompletions: argumentCompletions(['on', 'off', 'status']),
      handler: async (args, ctx) => {
        const session = managed();
        if (typeof session?.session?.managedSetPermission !== 'function') { ctx.ui.notify('Cuộc trò chuyện này chưa sẵn sàng.', 'error'); return; }
        const arg = args.trim().toLowerCase();
        let mode = arg === 'on' ? 'trusted-full-access' : arg === 'off' ? 'workspace-write' : null;
        if (!mode && arg !== 'status') {
          const choice = await ctx.ui.select(`Quyền của cuộc trò chuyện này (đang: ${session.permission === 'trusted-full-access' ? 'Bypass' : 'Hỏi trước'})`, [ASK, BYPASS]);
          mode = choice === BYPASS ? 'trusted-full-access' : choice === ASK ? 'workspace-write' : null;
        }
        if (mode && mode !== session.permission) session.session.managedSetPermission(mode);
        showPermission(ctx);
        ctx.ui.notify(PERMISSION_TEXT[session.permission] ?? PERMISSION_TEXT['workspace-write'], 'info');
      } });

    // /undo: the files the last turn changed go back to how they were before
    // it, unless one changed again since (checkpoints.mjs).
    pi.registerCommand('undo', {
      description: 'Hoàn tác file mà lượt trước của agent đã sửa (project là git repository)',
      handler: async (_args, ctx) => {
        const session = managed();
        if (!session?.boundary) { ctx.ui.notify('Cuộc trò chuyện này chưa sẵn sàng.', 'error'); return; }
        try { ctx.ui.notify((await checkpointsOf(session).undo()).text, 'info'); }
        catch (error) { ctx.ui.notify(`Không hoàn tác được: ${String(error?.message ?? error).slice(0, 300)}`, 'error'); }
      } });

    // Fast mode, where the team's Harness allows it; off until the member turns it on.
    const showFast = (ctx) => ctx.ui?.setStatus?.('agent-watch-fast', managed()?.session?.managedFastState?.() === 'on' ? 'Fast' : undefined);
    pi.on('session_start', async (_event, ctx) => showFast(ctx));
    pi.registerCommand('fast', {
      description: 'Bật/tắt Fast cho cuộc trò chuyện công ty này (on, off, status); chỉ có khi Harness của team cho phép',
      getArgumentCompletions: argumentCompletions(['on', 'off', 'status']),
      handler: async (args, ctx) => {
        const session = managed()?.session, state = session?.managedFastState?.();
        if (typeof session?.managedSetFast !== 'function') { ctx.ui.notify('Cuộc trò chuyện này chưa sẵn sàng.', 'error'); return; }
        if (!state) { ctx.ui.notify('Harness của team không cho phép Fast. Admin bật trong Agent Studio → Harness → Fast mode.', 'warning'); return; }
        const arg = args.trim().toLowerCase();
        if (!['', 'on', 'off', 'status'].includes(arg)) { ctx.ui.notify('Cách dùng: /fast on|off|status', 'warning'); return; }
        if (arg === 'on' || arg === 'off') session.managedSetFast(arg === 'on');
        else if (arg === '') session.managedSetFast(state !== 'on');
        showFast(ctx);
        ctx.ui.notify(session.managedFastState() === 'on'
          ? session.managedFastServed?.() === false
            ? 'Fast đang bật nhưng model hiện tại của main agent không hỗ trợ Fast (chỉ các model GPT qua Codex): các lượt vẫn chạy tốc độ thường, quota tính như thường.'
            : 'Fast đang bật: main agent trả lời nhanh hơn trên model GPT, token tính vào quota gấp 2,5 lần. Model và mức suy luận không đổi.'
          : 'Fast đang tắt: các lượt chạy tốc độ thường.', 'info');
      } });

    // /help is answered here, as on the dashboard: no model request (Pi has no
    // /help of its own, so the text would otherwise go to the agent).
    pi.registerCommand('help', {
      description: 'Lệnh và phím tắt của Terminal công ty (không gửi model)',
      handler: async (_args, ctx) => ctx.ui.notify(HELP_TEXT, 'info') });

    // The company header, footer and / suggestions; Pi resets extension UI on
    // every session switch, so they are set again on each session_start.
    let last = null;
    const summary = () => {
      const grant = managed()?.grant;
      if (grant?.effort) last = { effort: grant.effort };
      return harnessSummary(managed(), { last, version: installed });
    };
    pi.on('session_start', async (_event, ctx) => {
      const ui = ctx.ui;
      if (!ctx.hasUI || ui?.[Symbol.for('piagent.webui.gateway-runtime-ui.v1')]) return;
      const { Text, truncateToWidth, visibleWidth } = await components();
      ui.setHeader?.((_tui, theme) => ({ invalidate() {},
        render: (width) => new Text(`${theme.bold(theme.fg('accent', headerText(summary())))}\n${theme.fg('dim', HEADER_KEYS)}`, 1, 0).render(width) }));
      ui.setFooter?.((_tui, theme, footerData) => ({ invalidate() {},
        render: (width) => footerLines({ session: managed()?.session, summary: summary(), footerData, theme, width, truncateToWidth, visibleWidth }) }));
      ui.addAutocompleteProvider?.((current) => ({ ...current, triggerCharacters: current.triggerCharacters,
        getSuggestions: async (...args) => companySuggestions(await current.getSuggestions(...args)),
        applyCompletion: (...args) => current.applyCompletion(...args),
        ...(current.shouldTriggerFileCompletion && { shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion(...args) }) }));
    });
    // While a question waits for the member, the loader says so instead of "Working".
    pi.on('tool_execution_start', async (event, ctx) => {
      if (event?.toolName !== 'ask_user') return;
      ctx.ui?.setWorkingMessage?.('Đang chờ bạn trả lời');
      ctx.ui?.setWorkingIndicator?.({ frames: ['?'] });
    });
    pi.on('tool_execution_end', async (event, ctx) => {
      if (event?.toolName !== 'ask_user') return;
      ctx.ui?.setWorkingMessage?.(WORKING); ctx.ui?.setWorkingIndicator?.();
    });

    // The Harness's notes carry English for the agent; the member reads them in Vietnamese.
    pi.registerMessageRenderer('agent-watch-process', (message, _options, theme) => {
      const lines = processLines(message.details);
      const loud = ['dispute', 'objection'].includes(message.details?.phase) || message.details?.outcome === 'disputed';
      return lines ? box(lines.join('\n'), theme, loud ? 'warning' : message.details?.outcome === 'clean' ? 'success' : 'muted') : undefined;
    });
    // How the member's message ended (finished, stopped with steps open,
    // failed, stopped), as the dashboard says it under the last answer.
    let heard = null;
    pi.on('session_start', async (_event, ctx) => {
      const session = managed()?.session;
      if (!session?.subscribe || heard === session) return;
      heard = session;
      // The conversation can close while git answers (a client ends right after a turn): its ctx is then stale.
      const showBranch = async () => { try { const branch = await branchOf(managed()?.cwd ?? ctx.cwd); ctx.ui?.setStatus?.('agent-watch-branch', branch ? `⎇ ${branch}` : undefined); } catch { /* closed meanwhile */ } };
      ctx.ui?.setWorkingMessage?.(WORKING);
      void showBranch();
      session.subscribe((event) => {
        if (event?.type === 'managed_helpers') ctx.ui?.setStatus?.('agent-watch-helpers', event.active ? `Subagent ${event.active}/${event.maximum}` : undefined);
        const end = event?.type === 'managed_turn_end' ? turnEndOf(event.end) : null;
        if (!end) return;
        const copy = turnEndCopy(end, LOCALE), stats = turnStats(session.messages);
        ctx.ui?.notify?.(`${copy.title}. ${copy.text.replace('Bấm Tiếp tục', 'Gửi "tiếp tục"').replace('bấm Tiếp tục', 'gửi "tiếp tục"')}${stats ? `\n${stats}` : ''}`, copy.tone === 'success' ? 'info' : copy.tone === 'error' ? 'error' : copy.tone === 'warning' ? 'warning' : 'info');
        void showBranch();
      });
    });
    pi.registerMessageRenderer('agent-watch-review-status', (_message, _options, theme) =>
      box('Review đã cũ: code đổi sau khi review. Cần review lại cho thay đổi hiện tại.', theme, 'warning'));
    pi.registerMessageRenderer('agent-watch-helper-receipt', (message, _options, theme) =>
      box(String(message.content ?? '').replace(/(\d[\d,]*) tokens/, '$1 token').replace('review is stale', 'review đã cũ'), theme, 'dim'));

    // A failed request says what it means and what to do, as on the dashboard.
    pi.on('message_end', async (event, ctx) => {
      const message = event?.message;
      if (message?.role !== 'assistant' || message.stopReason !== 'error') return;
      const text = failureLines(message.errorMessage);
      if (text) ctx.ui?.notify?.(text, 'error');
    });
  };
}
