# Read and edit project files in Session Hub

[Tiếng Việt](../vi/workspace-editor.md)

Open a conversation in `piagent dashboard`, then choose **Files**. On a wide
screen the sidebar lists the project tree and the editor sits beside chat. On
smaller screens Files opens a drawer. Choose **Sessions** to return to the
conversation list.

Choose a file to open an editor tab. Cmd/Ctrl+P searches file names. **Search**
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
existing sandbox. Writes use that same boundary. Browser access never receives a Studio grant.

JavaScript, TypeScript, JSON, Markdown, Python, HTML and CSS parsers load when
needed; other files remain readable as plain text.

With write access, edit text and press **Cmd/Ctrl+S** or **Save**. A dot marks
unsaved tabs. Closing a dirty tab asks before discarding it; hiding Files or
switching conversations keeps drafts in this page's memory. Leaving the page
warns about unsaved drafts. Drafts are not restored after a browser restart.
**New file** accepts a relative path in an existing directory; save to create it.
Renaming and deleting files are deferred.

Saving checks the current permission profile, protected/read-only paths and the
file digest. If the file changed, choose **Reload**, **Compare** or **Overwrite**.
Overwrite requires confirmation and still checks the version shown in the dialog.
A connection failure keeps the draft; retrying the save uses the same command so
it cannot write twice. An uncertain result asks you to reload and check first.

A notice says when the agent is running. A successful member save refreshes
Source Changes and gives the next agent turn a short note naming the edited
files. An agent that read an older version must read again before edit/write.
Company reads and writes share the agent's queue inside the existing sandbox.
Read-only access disables saving, and the server checks access again on each save.
Interactive terminals, inline hunk review and checkpoint restore are later milestones.
