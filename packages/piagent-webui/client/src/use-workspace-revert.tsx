import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Command } from '../../contracts/generated/control-command-v1.ts';
import type { PiagentWebUIConfirmedExactSourceRevertPreviewV1 as Preview } from '../../contracts/generated/source-revert-v1.ts';
import type { PiagentWebUIBoundedFileDiffV1 as Diff } from '../../contracts/generated/diff-v1.ts';
import { readSessionSourceRevert, sendSourceRevertCommand } from './api.ts';
import { createSessionSourceRevertCommand } from './source-revert-command.ts';
import { localize, useUiPreferences } from './ui-preferences.tsx';
// Retain a sent command across tab/drawer switches, without copying source text.
// A retry must ask about the same idempotency key, even after a lost response.
const pending = new Map<string, Command>();
export function useWorkspaceRevert(session: string, path: string | undefined, digest: string | null, clean: boolean, diff?: Diff) {
  const { locale } = useUiPreferences(), key = `${session}\0${path ?? ''}`, scope = `${key}\0${digest}\0${clean}`;
  const current = useRef(scope); current.current = scope;
  const currentKey = useRef(key); currentKey.current = key;
  const busyRef = useRef(false), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ value: Preview; scope: string }>(), [message, setMessage] = useState<string>();
  const [hasPending, setHasPending] = useState(false);
  useEffect(() => { setOpen(false); setPreview(undefined); setMessage(undefined); setHasPending(pending.has(key)); }, [key]);
  const request = async (hunkRef: string) => {
    if (busyRef.current || !clean || !diff || diff.file.path !== path || diff.file.currentDigest !== `sha256:${digest}`) return;
    setOpen(true); setMessage(undefined); setPreview(undefined); setHasPending(pending.has(key));
    if (pending.has(key)) return;
    busyRef.current = true; setBusy(true);
    try {
      const value = await readSessionSourceRevert(session, diff.file.fileRef, hunkRef);
      if (current.current !== scope) return;
      if (value.state !== 'ready' || !value.target || value.target.path !== path || value.target.fileRef !== diff.file.fileRef || value.target.fileRevision !== diff.file.fileRevision || !value.target.hunkRefs.some(ref => ref === hunkRef))
        throw new Error('preview-unavailable');
      setPreview({ value, scope });
    } catch { if (current.current === scope) setMessage(localize(locale, 'Chưa thể hoàn tác an toàn. Tải lại diff và thử lại.', 'Safe revert is unavailable. Refresh the diff and try again.')); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const confirm = async () => {
    if (busyRef.current || !clean || (!pending.has(key) && (!preview || preview.scope !== scope))) return;
    busyRef.current = true; setBusy(true); setMessage(undefined);
    try {
      const command = pending.get(key) ?? await createSessionSourceRevertCommand(preview!.value);
      if (current.current !== scope) return;
      // Never evict an uncertain command: its retry identity must survive.
      if (!pending.has(key) && pending.size >= 128) {
        setMessage(localize(locale, 'Có quá nhiều lệnh chưa rõ kết quả. Kiểm tra lại các lệnh trước trước khi hoàn tác thêm.',
          'Too many commands still need their results checked. Check earlier commands before reverting more.'));
        return;
      }
      pending.set(key, command); setHasPending(true);
      const receipt = await sendSourceRevertCommand(command, undefined, session);
      if (receipt.phase !== 'uncertain') pending.delete(key);
      if (currentKey.current === key) setHasPending(pending.has(key));
      window.dispatchEvent(new CustomEvent('piagent-workspace-changed', { detail: { sessionRef: session } }));
      if (current.current !== scope) return;
      setHasPending(pending.has(key));
      if (receipt.phase === 'settled') { setOpen(false); setPreview(undefined); }
      else { if (receipt.phase === 'rejected') setPreview(undefined); setMessage(receipt.phase === 'uncertain'
        ? localize(locale, 'Chưa xác định được kết quả. Kiểm tra tệp; kiểm tra lại sẽ dùng đúng lệnh cũ.', 'The result is uncertain. Inspect the file; checking again uses the same command.')
        : localize(locale, 'Tệp hoặc quyền đã thay đổi. Hãy đóng và xem preview mới.', 'The file or permission changed. Close this dialog and request a new preview.')); }
    } catch { if (current.current === scope) setMessage(localize(locale, 'Chưa nhận được kết quả. Kiểm tra lại dùng cùng lệnh, không tạo lần hoàn tác mới.', 'No result received. Checking again reuses the same command.')); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const stale = preview && preview.scope !== scope;
  const dialog = <Dialog open={open} onClose={() => { if (!busy) setOpen(false); }} fullWidth maxWidth="md">
    <DialogTitle>{localize(locale, 'Hoàn tác thay đổi của agent', 'Revert agent changes')}</DialogTitle>
    <DialogContent><Typography>{path}</Typography>
      <Typography>{localize(locale, 'Các dòng dưới đây sẽ được hoàn tác. Git index được giữ nguyên.', 'The changes below will be reverted. The Git index is preserved.')}</Typography>
      {message && <Alert severity="warning">{message}</Alert>}
      {stale && <Alert severity="warning">{localize(locale, 'Nội dung editor đã đổi. Mở lại preview trước khi hoàn tác.', 'Editor contents changed. Open a new preview before reverting.')}</Alert>}
      {hasPending && !preview && <Alert severity="info">{localize(locale, 'Có lệnh chưa xác nhận kết quả cho tệp này.', 'A command for this file still needs its result confirmed.')}</Alert>}
      {preview?.value.preview?.hunks.map(hunk => <Box component="pre" key={hunk.hunkRef} sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{hunk.header}{'\n'}{hunk.lines.map(line => `${line.marker}${line.text}`).join('\n')}</Box>)}
    </DialogContent>
    <DialogActions><Button disabled={busy} onClick={() => setOpen(false)}>{localize(locale, 'Đóng', 'Close')}</Button>
      <Button color="error" disabled={busy || !clean || (!hasPending && (!preview || !!stale))} onClick={() => void confirm()}>
        {hasPending ? localize(locale, 'Kiểm tra lại', 'Check again') : localize(locale, 'Xác nhận hoàn tác', 'Confirm revert')}</Button></DialogActions>
  </Dialog>;
  return { request, dialog, hasPending, checkPending: () => { setHasPending(pending.has(key)); setOpen(true); } };
}
