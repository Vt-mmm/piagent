# Read project files in Session Hub

[Tiếng Việt](../vi/workspace-editor.md)

Open a conversation in `piagent dashboard`, then choose **Files**. On a wide
screen the sidebar lists the project tree and the editor sits beside chat. On
smaller screens Files opens a drawer. Choose **Sessions** to return to the
conversation list.

Choose a file to open a read-only tab. Cmd/Ctrl+P searches file names. **Search**
finds literal text and opens results at their line. File links on tool cards,
source changes and `@path:line` mentions also open the editor. **Open in VS Code**
remains available in source changes.

The tree respects Git ignore rules and loads one directory at a time. Lists and
searches have limits and say when results are truncated. Without ripgrep, search
uses an existing Context Engine index; it does not create an index and may only
find indexed files. The view reports when search is unavailable.

Protected files show a lock and cannot be opened. Binary and oversized files show
a notice instead of content. Unsafe paths and symlinks are refused. Company
requests go through the company Gateway and read files inside the session's
existing sandbox. Browser access never receives a Studio grant.

JavaScript, TypeScript, JSON, Markdown, Python, HTML and CSS parsers load when
needed; other files remain readable as plain text. This milestone does not yet
save edits, open an interactive terminal or restore checkpoints.
