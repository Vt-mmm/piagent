import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { workspaceLanguage } from "./workspace-language.ts";
import { EditorView, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { useTheme } from "@mui/material/styles";
import Box from "@mui/material/Box";

export default function WorkspaceCodeEditor({ content, path, line = 1 }: { content: string; path: string; line?: number }) {
  const host = useRef<HTMLDivElement>(null), theme = useTheme();
  useEffect(() => {
    if (!host.current) return;
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
    const language = new Compartment();
    let disposed = false;
    // Dynamic editor styles share the page nonce; no global CSP exception.
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: content, extensions: [
      EditorView.cspNonce.of(nonce ?? ""), EditorState.readOnly.of(true), EditorView.editable.of(false),
      lineNumbers(), highlightActiveLineGutter(), syntaxHighlighting(defaultHighlightStyle), language.of([]), EditorView.contentAttributes.of({ "aria-label": path, tabindex: "0" }),
      EditorView.theme({ "&": { height: "100%", color: theme.palette.text.primary, backgroundColor: theme.palette.background.paper },
        ".cm-scroller": { overflow: "auto", fontFamily: "monospace" },
        ".cm-gutters": { backgroundColor: theme.palette.background.default, color: theme.palette.text.secondary } }, { dark: theme.palette.mode === "dark" })
    ] }) });
    const target = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line))).from;
    view.dispatch({ selection: { anchor: target }, effects: EditorView.scrollIntoView(target, { y: "center" }) });
    void workspaceLanguage(path).then(extension => {
      if (!disposed) view.dispatch({ effects: language.reconfigure(extension) });
    }).catch(() => { /* Plain text remains readable when a language chunk cannot load. */ });
    return () => { disposed = true; view.destroy(); };
  }, [content, path, line, theme]);
  return <Box ref={host} sx={{ height: "100%", minHeight: 240, overflow: "hidden" }} />;
}
