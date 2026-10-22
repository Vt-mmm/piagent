import { lazy, Suspense, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import { localize, useUiPreferences } from './ui-preferences.tsx';
import { terminalSessionClient } from './terminal-session-client.ts';
const View = lazy(() => import('./TerminalView.tsx'));
export default function TerminalPanel({ sessionRef }: { sessionRef: string }) {
  const { locale } = useUiPreferences(), client = useMemo(() => terminalSessionClient(sessionRef), [sessionRef]);
  const model = useSyncExternalStore(client.subscribe, client.snapshot), state = model.state;
  const [selected, setSelected] = useState<string | null>(null), [height, setHeight] = useState(280);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const active = state?.terminals.find(tab => tab.terminalRef === selected)?.terminalRef ?? state?.terminals[0]?.terminalRef ?? null;
  const blocked = !model.connected || !state?.available || Boolean(model.pending && !model.busy);
  return <Box component="section" aria-label={localize(locale, 'Terminal', 'Terminal')} sx={{ borderTop: 1, borderColor: 'divider', minWidth: 0 }}>
    <Box role="separator" tabIndex={0} aria-label={localize(locale, 'Chiều cao terminal', 'Terminal height')} aria-orientation="horizontal"
      aria-valuenow={height} aria-valuemin={160} aria-valuemax={700}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setHeight(value => Math.max(160, Math.min(700, value + (event.key === 'ArrowUp' ? 20 : -20)))); } }}
      onPointerDown={event => { drag.current = { y: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current) setHeight(Math.max(160, Math.min(700, drag.current.height + drag.current.y - event.clientY))); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      sx={{ height: 8, cursor: 'row-resize', touchAction: 'none', bgcolor: 'action.hover' }} />
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Tabs value={active ?? false} onChange={(_, value) => setSelected(value)} variant="scrollable" sx={{ flex: 1, minWidth: 0 }}>
        {state?.terminals.map(tab => <Tab key={tab.terminalRef} value={tab.terminalRef} label={`Terminal ${tab.number}${tab.state === 'exited' ? localize(locale, ' · đã thoát', ' · exited') : ''}`} />)}
      </Tabs>
      <Button disabled={blocked || model.busy || (state?.terminals.length ?? 0) >= 4} aria-label={localize(locale, 'Mở terminal', 'Open terminal')}
        onClick={() => void client.execute({ kind: 'open', cols: 80, rows: 24 })}>+</Button>
      {active && <Button disabled={blocked || model.busy} onClick={() => void client.execute({ kind: 'close', terminalRef: active })}>{localize(locale, 'Đóng terminal', 'Close terminal')}</Button>}
    </Box>
    {!model.connected && <Alert severity="info">{localize(locale, 'Đang nối lại terminal…', 'Reconnecting terminal…')}</Alert>}
    {state && !state.available && <Alert severity="info">{localize(locale, 'Terminal chưa khả dụng trên môi trường này.', 'Terminal is unavailable in this environment.')} {state.reasonCode}</Alert>}
    {model.error && <Alert severity="warning">{localize(locale, 'Thao tác terminal chưa hoàn tất.', 'The terminal action did not complete.')} {model.error}
      {model.pending ? <>
        <Typography variant="body2">{localize(locale, 'Kiểm tra output trước khi tiếp tục. Lệnh có thể đã chạy.', 'Check the output before continuing. The command may have run.')}</Typography>
        <Button disabled={model.busy || !model.connected} onClick={() => void client.retry()}>{localize(locale, 'Kiểm tra lại lệnh', 'Check command again')}</Button>
        <Button disabled={model.busy} onClick={client.acknowledge}>{localize(locale, 'Đã kiểm tra, tiếp tục', 'Checked, continue')}</Button>
      </> : <Button onClick={() => void client.refresh()}>{localize(locale, 'Tải lại', 'Refresh')}</Button>}
    </Alert>}
    {!state && !model.error && <CircularProgress size={24} />}
    {state?.available && !state.terminals.length && <Typography sx={{ p: 2 }}>{localize(locale, 'Nhấn + để mở terminal trong project.', 'Press + to open a terminal in the project.')}</Typography>}
    <Typography variant="caption" sx={{ px: 1 }}>{localize(locale, "Gõ @terminal hoặc @terminal:2 trong tin nhắn để đính output đã che secret khi gửi.", "Use @terminal or @terminal:2 in your message to attach redacted output when you send.")}</Typography>
    <Box sx={{ height, minWidth: 0 }}>
      <Suspense fallback={<CircularProgress size={24} />}>
        {state?.terminals.map(tab => <View key={`${state.identity.runtimeInstanceRef}:${tab.terminalRef}`} identity={state.identity} terminalRef={tab.terminalRef}
          active={active === tab.terminalRef} onReady={() => void client.refresh()} onError={client.error}
          onInput={data => { if (!blocked && tab.state === 'running') void client.execute({ kind: 'input', terminalRef: tab.terminalRef, data }); }}
          onResize={(cols, rows) => { if (!blocked && tab.state === 'running') void client.execute({ kind: 'resize', terminalRef: tab.terminalRef, cols, rows }); }} />)}
      </Suspense>
    </Box>
  </Box>;
}
