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

## Review agent changes

Open files show proven agent hunks with added lines, removed-line blocks and gutter
markers. Each open tab shows its remaining hunk count. **Alt+ArrowDown/Up** moves
between hunks. **Keep** removes a hunk from review without changing the file; it
survives closing the drawer in this page, and changed content needs review again.
Reloading the page clears these Keep choices.

**Revert** opens a preview and requires confirmation. It uses the existing guarded
source revert and preserves the Git index. If the response is lost, **Check again**
asks about the same command. Revert is unavailable for mixed member/agent hunks,
stale content, protected paths and unsupported changes. Newly created untracked
agent files can be reviewed and kept; deleting them through revert is not yet
supported. A pre-existing member file is not treated as wholly agent-authored.

Agent activity refreshes clean open files. Unsaved drafts stay intact and show the
same conflict choices as saving. Hunk decorations disappear while editing a draft.
**Comment on current line** or **Cmd/Ctrl+Shift+M** opens LineReview. Removed lines
have their own comment button and retain the old line number and text. **Put in the
composer** appends comments to your draft; send the message to ask the agent to act.

Attribution requires an exact observed write/edit/patch in this session and a
current, complete, unredacted diff. CRLF and missing final newlines are compared
exactly. Unobserved shell edits and observations lost on runtime restart do not
receive agent hunk markers. Company review and revert run inside its sandbox.
Interactive terminals and checkpoint restore are later milestones.

## Personal terminal

Choose **Terminal** beside Files, then **+** to open the member's shell in the
conversation's project. Each conversation supports four tabs. The panel sits
below the editor on wide screens and opens a bottom drawer on smaller screens.
Drag the separator to change its height, or focus it and use the arrow keys.
The terminal follows the current theme; Ctrl+C interrupts the foreground command.

Typed commands run with the member's host privileges, without an agent approval
prompt. Personal terminal execution is not a sandbox. Closing a terminal,
releasing or restarting its session, or shutting down the Gateway stops its
process group and observed descendants. A shell exit also cleans remaining
process-group children. Processes deliberately detached into another session
are outside that process group's lifetime.

Hiding the panel or reloading the page preserves the shell while its Gateway
runtime remains alive. Reopening replays up to 64 KB of retained output per tab.
Replay and agent attachments redact recognized secrets; the live terminal shows
the member's own raw output. Restarting the Gateway clears terminals and buffers.
If a command's receipt is lost, input pauses: **Check command again** asks about
the same command. Check the terminal before choosing **Checked, continue**.
Pending commands survive panel changes in page memory, not a page reload.

Write `@terminal` (terminal 1) or `@terminal:2` in the composer, then press Send
to attach the current redacted output. Repeated mentions attach a tab once, with
at most four tabs and a combined 64 KB of output. Missing terminals refuse the
send. Output is quoted as untrusted evidence; merely typing a mention sends
nothing. Tab numbers increase within the runtime and are not reused after close.

The optional native PTY module can be unavailable. The panel explains this and
`piagent-doctor --json` reports `productReadiness.personalTerminal`; other dashboard
features remain usable. Doctor checks module loading and does not claim a shell
spawn test. Native Windows is unavailable; use WSL. Company terminal execution
is not enabled by this personal implementation and never falls back to a host shell.
