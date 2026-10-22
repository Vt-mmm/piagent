import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { CheckpointCommand, CheckpointPreview, CheckpointReceipt, CheckpointState } from '../../contracts/generated/checkpoint-v1.ts';
import { checkpointCommand, previewCheckpoint, readCheckpoints, restoreCheckpoint } from './checkpoint-api.ts';
import { pendingCheckpoint, savePendingCheckpoint, clearPendingCheckpoint } from './checkpoint-pending.ts';
import { localize, type UiLocale } from './ui-preferences.tsx';

type Context = { state?: CheckpointState; busy: boolean; open(id: string): void; locale: UiLocale };
const Checkpoints = createContext<Context | null>(null);
export function TurnCheckpointButton({ turnRef }: { turnRef: string }) {
  const context = useContext(Checkpoints), point = context?.state?.points.find(point => point.turnRef === turnRef);
  if (!context || !point) return null;
  return <Button size="small" disabled={context.busy || context.state?.agentRunning} onClick={() => context.open(point.id)} sx={{ alignSelf: 'flex-start' }}>
    {localize(context.locale, 'Khôi phục về trước lượt này', 'Restore before this turn')}
  </Button>;
}
export function CheckpointTimeline({ sessionRef, refresh, running, locale, children }: {
  sessionRef: string; refresh: string; running: boolean; locale: UiLocale; children: ReactNode;
}) {
  const [state, setState] = useState<CheckpointState>(), [reload, setReload] = useState(0);
  const [opened, setOpened] = useState(false), [loading, setLoading] = useState(false), [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<CheckpointPreview>(), [receipt, setReceipt] = useState<CheckpointReceipt>();
  const [error, setError] = useState(false);
  const [recovery] = useState(() => { try { return { command: pendingCheckpoint(sessionRef), failed: false }; }
    catch { return { command: undefined, failed: true }; } });
  const [pending, setPending] = useState<CheckpointCommand | undefined>(recovery.command);
  const [storageError, setStorageError] = useState(recovery.failed);
  const request = useRef<AbortController | null>(null), dispatching = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void readCheckpoints(sessionRef, controller.signal).then(value => { if (!controller.signal.aborted) setState(value); }).catch(() => {});
    return () => controller.abort();
  }, [sessionRef, refresh, reload]);
  const open = (id: string) => {
    setOpened(true); setReceipt(undefined); setError(false);
    if (pending) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setPreview(undefined); setLoading(true);
    void previewCheckpoint(sessionRef, id, controller.signal).then(value => { if (!controller.signal.aborted) setPreview(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  };
  const send = async () => {
    if (storageError || dispatching.current || (!pending && (!preview || running || state?.agentRunning || !['ready', 'conflict'].includes(preview.result)))) return;
    dispatching.current = true; setSending(true); setError(false);
    try {
      const command = pending ?? await checkpointCommand(preview!);
      try { savePendingCheckpoint(sessionRef, command); }
      catch { setStorageError(true); return; }
      setPending(command);
      const result = await restoreCheckpoint(sessionRef, command);
      if (result.phase !== 'uncertain') clearPendingCheckpoint(sessionRef, command);
      if (!alive.current) return;
      setReceipt(result); if (result.phase !== 'uncertain') setPending(undefined);
      setReload(value => value + 1);
    } catch { if (alive.current) setError(true); }
    finally {
      // Unknown responses may also have changed files. The existing refresh path
      // reconciles digests and preserves unsaved editor drafts.
      window.dispatchEvent(new CustomEvent('piagent-workspace-changed', { detail: { sessionRef } }));
      dispatching.current = false; if (alive.current) setSending(false);
    }
  };
  const close = () => { if (dispatching.current) return; request.current?.abort(); setOpened(false); setLoading(false); };
  const conflicts = receipt?.conflicts ?? preview?.conflicts ?? [];
  const uncertain = receipt?.phase === 'uncertain' || error && !!pending;
  return <Checkpoints.Provider value={{ state, busy: running || sending || storageError, open, locale }}>
    {state && !state.available && <Typography variant="caption" color="text.secondary">{localize(locale,
      'Project không dùng Git nên không có checkpoint để khôi phục.', 'This project has no Git repository, so checkpoints are unavailable.')}</Typography>}
    {pending && !opened && <Alert severity="warning" action={<Button color="inherit" onClick={() => open(pending.payload.targetId)}>{localize(locale, 'Xem kết quả', 'Check result')}</Button>}>
      {localize(locale, 'Một lần khôi phục chưa có kết quả xác nhận.', 'A restore is awaiting a confirmed result.')}</Alert>}
    {storageError && !opened && <Alert severity="error">{localize(locale,
      'Không đọc hoặc lưu được yêu cầu khôi phục đang chờ trong trình duyệt. Chưa gửi yêu cầu mới; hãy kiểm tra file trước khi tiếp tục.',
      'The browser could not read or save the pending restore. No new request was sent; inspect your files before continuing.')}</Alert>}
    {children}
    <Dialog open={opened} onClose={close} fullWidth maxWidth="sm" aria-labelledby="checkpoint-dialog-title">
      <DialogTitle id="checkpoint-dialog-title">{localize(locale, 'Khôi phục về trước lượt này', 'Restore before this turn')}</DialogTitle>
      <DialogContent><Stack spacing={2}>
    {storageError && <Alert severity="error">{localize(locale,
      'Không đọc hoặc lưu được yêu cầu khôi phục đang chờ trong trình duyệt. Chưa gửi yêu cầu mới; hãy kiểm tra file trước khi tiếp tục.',
      'The browser could not read or save the pending restore. No new request was sent; inspect your files before continuing.')}</Alert>}

        {loading && <Typography>{localize(locale, 'Đang xem trước…', 'Loading preview…')}</Typography>}
        {preview && !receipt && <>
          <Typography>{localize(locale, `Sẽ hoàn tác ${preview.steps.length} lượt từ mới nhất về lượt đã chọn. Commit và vùng stage được giữ nguyên.`,
            `Undo ${preview.steps.length} turns from newest to the selected turn. Commits and staged changes are preserved.`)}</Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{preview.files.join('\n')}</Typography>
          {!['ready', 'conflict'].includes(preview.result) && <Alert severity="info">{localize(locale, 'Checkpoint hiện không thể khôi phục. Đóng hộp thoại rồi xem trước lại khi lượt chạy kết thúc.',
            'This checkpoint cannot be restored now. Close this dialog and preview again after the running turn ends.')}</Alert>}
        </>}
        {conflicts.length > 0 && <Alert severity="warning">{localize(locale, 'Sẽ dừng trước file đã thay đổi sau lượt: ', 'Stop before files changed after the turn: ')}{conflicts.join(', ')}</Alert>}
        {receipt && !uncertain && <Alert severity={receipt.resultCode === 'restored' ? 'success' : 'warning'}>
          {receipt.resultCode === 'restored' ? localize(locale, `Đã khôi phục ${receipt.completed.length} lượt.`, `Restored ${receipt.completed.length} turns.`)
            : receipt.resultCode === 'conflict' ? localize(locale, `Đã khôi phục ${receipt.completed.length} lượt và dừng để giữ thay đổi của bạn.`, `Restored ${receipt.completed.length} turns and stopped to preserve your changes.`)
              : localize(locale, 'Chưa khôi phục: trạng thái hoặc quyền đã thay đổi. Đóng hộp thoại và xem trước lại.', 'Not restored: state or permissions changed. Close this dialog and preview again.')}
        </Alert>}
        {uncertain && <Alert severity="warning">{localize(locale, 'Chưa xác nhận được kết quả; một số file có thể đã thay đổi. Kiểm tra file trước khi tiếp tục. Nút bên dưới chỉ kiểm tra lại cùng yêu cầu.',
          'The result is unconfirmed; some files may have changed. Inspect them before continuing. The button below checks the same request.')}</Alert>}
        {error && !pending && <Alert severity="error">{localize(locale, 'Không tải được preview. Đóng hộp thoại và thử lại.', 'Could not load the preview. Close this dialog and try again.')}</Alert>}
      </Stack></DialogContent>
      <DialogActions><Button disabled={sending} onClick={close}>{localize(locale, 'Đóng', 'Close')}</Button>
        {(!receipt || uncertain) && <Button variant="contained" disabled={storageError || sending || loading || !pending && (running || state?.agentRunning || !preview?.steps.length || !['ready', 'conflict'].includes(preview?.result ?? ''))} onClick={() => void send()}>
          {pending ? localize(locale, 'Kiểm tra lại kết quả', 'Check result again') : localize(locale, 'Xác nhận khôi phục', 'Confirm restore')}
        </Button>}
      </DialogActions>
    </Dialog>
  </Checkpoints.Provider>;
}
