import type { Extension } from "@codemirror/state";

// Only fetch a parser when a file using that language is opened.
export async function workspaceLanguage(path: string): Promise<Extension> {
  const extension = path.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "js": case "mjs": case "cjs": case "jsx": case "ts": case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: extension === "ts" || extension === "tsx", jsx: extension === "jsx" || extension === "tsx",
      });
    case "json": return (await import("@codemirror/lang-json")).json();
    case "md": return (await import("@codemirror/lang-markdown")).markdown();
    case "py": return (await import("@codemirror/lang-python")).python();
    case "html": return (await import("@codemirror/lang-html")).html();
    case "css": return (await import("@codemirror/lang-css")).css();
    default: return [];
  }
}
