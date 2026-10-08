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
import { companyFailureText } from '../packages/piagent-webui/shared/company-copy.ts';
import { headlineText, outcomeText, processItems } from '../packages/piagent-webui/shared/process-copy.ts';
import { turnEndCopy, turnEndOf } from '../packages/piagent-webui/shared/turn-end.ts';

const LOCALE = 'vi';
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
