import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalIdentity, TerminalOutput } from '../../contracts/generated/terminal-v1.ts';
import { terminalTransport } from './terminal-transport.ts';

function nonceDocument(nonce: string): Document {
  return new Proxy(document, { get(target, key) {
    if (key === 'createElement') return (tag: string, options?: ElementCreationOptions) => {
      const element = target.createElement(tag, options);
      if (tag.toLowerCase() === 'style') element.setAttribute('nonce', nonce);
      return element;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
export default function TerminalView({ identity, terminalRef, active, onInput, onResize, onReady, onError }: {
  identity: TerminalIdentity; terminalRef: string; active: boolean;
  onInput(data: string): void; onResize(cols: number, rows: number): void; onReady(): void; onError(reason: string): void;
}) {
  const host = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null);
  const theme = useTheme(), callbacks = useRef({ onInput, onResize, onReady, onError });
  callbacks.current = { onInput, onResize, onReady, onError };
  const colors = { background: theme.palette.background.paper, foreground: theme.palette.text.primary,
    cursor: theme.palette.text.primary, selectionBackground: theme.palette.action.selected };
  const currentColors = useRef(colors); currentColors.current = colors;
  useEffect(() => {
    const node = host.current, nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
    if (!node || !nonce || nonce.startsWith('__PIAGENT_')) { callbacks.current.onError('terminal-csp-unavailable'); return; }
    const value = new Terminal({ documentOverride: nonceDocument(nonce), theme: currentColors.current,
      fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', scrollback: 2000,
      allowProposedApi: false, allowTransparency: false });
    const addon = new FitAddon(); value.loadAddon(addon); value.open(node); terminal.current = value; fit.current = addon;
    let disposed = false, pendingBytes = 0, sequence = -1, replaying = false, skipping = false;
    const receive = (message: TerminalOutput) => {
      if (message.replay) {
        if (message.reset) { value.write('', () => { if (!disposed) value.reset(); }); replaying = true; skipping = false; }
        if (!replaying) return;
      } else if (replaying || message.sequence <= sequence) return;
      const bytes = new TextEncoder().encode(message.data).length;
      // While the renderer is behind, live output is skipped (not the whole
      // terminal): once it catches up the member sees a marker and carries on.
      if (!message.replay && pendingBytes + bytes > 512 * 1024) { skipping = true; sequence = message.sequence; return; }
      if (skipping && pendingBytes < 128 * 1024) { skipping = false; value.write('\r\n\x1b[2m[… output skipped …]\x1b[0m\r\n'); }
      if (skipping) { sequence = message.sequence; return; }
      pendingBytes += bytes;
      value.write(message.data, () => { pendingBytes -= bytes; });
      if (!message.replay || message.complete) { sequence = message.sequence; replaying = false; }
    };
    const unsubscribe = terminalTransport.subscribe(message => {
      if (message.identity.sessionRef !== identity.sessionRef || message.identity.runtimeInstanceRef !== identity.runtimeInstanceRef
        || message.identity.gatewayInstanceRef !== identity.gatewayInstanceRef || message.messageType !== 'output' || message.terminalRef !== terminalRef) return;
      receive(message);
    });
    let inputBuffer = '', inputTimer: ReturnType<typeof setTimeout> | undefined;
    const flushInput = () => { inputTimer = undefined; const data = inputBuffer; inputBuffer = ''; if (data) callbacks.current.onInput(data); };
    const input = value.onData(data => {
      if (new TextEncoder().encode(data).length > 16384) { callbacks.current.onError('terminal-input-limit'); return; }
      if (new TextEncoder().encode(inputBuffer + data).length > 16384) { clearTimeout(inputTimer); flushInput(); }
      inputBuffer += data;
      if (!inputTimer) inputTimer = setTimeout(flushInput, 16);
    });
    const resize = value.onResize(({ cols, rows }) => callbacks.current.onResize(Math.min(500, Math.max(2, cols)), Math.min(200, Math.max(1, rows))));
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      if (!disposed && node.clientWidth && node.clientHeight) addon.fit();
    }); }); observer.observe(node);
    callbacks.current.onReady();
    return () => { disposed = true; clearTimeout(inputTimer); cancelAnimationFrame(frame); observer.disconnect(); unsubscribe(); input.dispose(); resize.dispose();
      value.dispose(); terminal.current = null; fit.current = null; };
  }, [identity.gatewayInstanceRef, identity.runtimeInstanceRef, identity.sessionRef, terminalRef]);
  useEffect(() => { if (terminal.current) terminal.current.options.theme = colors; }, [theme]);
  useEffect(() => { if (active && terminal.current && host.current?.clientWidth) { fit.current?.fit(); terminal.current.focus(); } }, [active]);
  return <Box ref={host} sx={{ display: active ? 'block' : 'none', height: '100%', minWidth: 0, overflow: 'hidden', p: 1 }} />;
}
