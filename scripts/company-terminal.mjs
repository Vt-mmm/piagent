// The company Terminal (`piagent studio`) says what the dashboard says: a new
// release is asked about, Bypass can be chosen, the Harness's notes and a
// failed request read in the member's words. Loaded only in the Terminal; the
// company Gateway draws its own pages.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerTerminalUpdateOffer } from '../packages/piagent-core/runtime/update/terminal-update-offer.mjs';
import { parseFailure } from '../packages/piagent-core/runtime/managed-failure.mjs';
import { checkpointsOf } from '../packages/piagent-core/managed/checkpoints.mjs';
import { companyFailureText } from '../packages/piagent-webui/shared/company-copy.ts';
import { headlineText, outcomeText, processItems } from '../packages/piagent-webui/shared/process-copy.ts';
import { turnEndCopy, turnEndOf } from '../packages/piagent-webui/shared/turn-end.ts';

const LOCALE = 'vi';
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
      afterUpdate: () => bindingChanged() ? 'Bản mới đổi trình khởi chạy công ty: mở Agent Watch → Studio và nhập lại cấu hình cho Piagent trước khi mở lại.' : null });

    // Ask first or Bypass, kept with the conversation like the dashboard's switch.
    const showPermission = (ctx) => ctx.ui?.setStatus?.(PERMISSION_STATUS, managed()?.permission === 'trusted-full-access' ? 'Bypass' : undefined);
    pi.on('session_start', async (_event, ctx) => showPermission(ctx));
    pi.registerCommand('bypass', {
      description: 'Bật/tắt Bypass cho cuộc trò chuyện công ty này (on, off, hoặc để trống để chọn)',
      getArgumentCompletions: (prefix) => ['on', 'off', 'status'].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
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
      getArgumentCompletions: (prefix) => ['on', 'off', 'status'].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
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
      session.subscribe((event) => {
        const end = event?.type === 'managed_turn_end' ? turnEndOf(event.end) : null;
        if (!end) return;
        const copy = turnEndCopy(end, LOCALE);
        ctx.ui?.notify?.(`${copy.title}. ${copy.text.replace('Bấm Tiếp tục', 'Gửi "tiếp tục"').replace('bấm Tiếp tục', 'gửi "tiếp tục"')}`, copy.tone === 'success' ? 'info' : copy.tone === 'error' ? 'error' : copy.tone === 'warning' ? 'warning' : 'info');
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
