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

A command that prints faster than the browser can draw (`yes`, a large `cat`)
is paced: the terminal pauses its writer while the page catches up, and output
the page could not keep up with is replaced by an `[… output skipped …]` marker.
The conversation on the same connection is not interrupted.

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
spawn test. Native Windows is unavailable; use WSL.


## Company terminal

Company conversations use the same terminal panel through the company Gateway,
including when opened from the personal dashboard. On Linux and WSL, the shell
starts inside the conversation's bubblewrap tool boundary. It has no internet,
package proxy or Docker access. Writes stay within the project and a private
temporary directory; a read-only profile keeps the project read-only. Credential
files are masked, and protected paths retain the boundary's restrictions.
The shell is Bash without startup files; it does not load the member's shell config.

Up to four terminals belong to each conversation. Closing a terminal, releasing
its conversation or shutting down the company Gateway stops its sandbox and
all descendants, including detached children. Hiding the panel and reloading the
browser preserve the terminal while the company runtime lives. A lost relay
connection disables input and reconnects for state and replay; it never resends
commands automatically. Explicit terminal mentions are attached inside the
company Gateway, and Studio grants stay there.

On macOS, the existing Seatbelt sandbox refuses PTY allocation, including the
fallback tested during qualification. The panel reports that company terminals
are unavailable; it never opens a company shell on the host. Other company
features remain usable. Native Windows is unavailable; use WSL.

`piagent-doctor --json` reports `productReadiness.companyTerminal`. A supported
result checks runtime files and prerequisites only (`ptySpawnVerified: false`);
it is not proof that this machine can spawn a sandboxed PTY. The complete
Gateway, relay and browser workflow was qualified on Linux arm64 in Docker.
Native Linux x64 and WSL were not independently qualified in this run.

## Restore an agent turn

In a Git project, a completed turn that changed files has **Restore before this
turn** in the Timeline. Open it to preview the affected files and number of turns,
then choose **Confirm restore**. Restoration runs from the newest turn back to
the selected turn. It removes files created by those turns and restores the
previous contents of files they changed. HEAD, commits made during a turn and
the member's staging area remain unchanged.

If a member changed an affected file afterward, restoration stops at that turn
and names the conflicting files. Newer safe turns may already have been restored;
the result reports how many. A running agent, changed preview or revoked write
permission requires a fresh preview. Protected and read-only paths retain their
restrictions. A project without Git has no checkpoints.

A file the member saved from the editor after a turn began counts as the
member's: restoring that turn names it as a conflict instead of putting it back.
Edits typed into a terminal are not tracked this way; the drift check still
refuses files changed after the turn ended.

Personal Pi TUI also supports `/undo` for the latest turn without asking the
model. Personal history retains up to 64 checkpoints per project and session in
owner-only `.pi/piagent-state/checkpoints` files; a conversation untouched for
30 days loses its checkpoints. Snapshots are kept in a private repository inside
the Git directory (`.git/piagent/checkpoints.git`), which uses the project's
objects but has its own refs: `git push --mirror` never publishes them, and the
project's garbage collection does not remove them. Snapshots include tracked files of any size,
skip untracked files over 100 MB and leave submodules out; undo never touches
what a snapshot left out. When a snapshot cannot be taken, the agent's edit
still proceeds; that turn has no checkpoint and earlier checkpoints are dropped,
because restoring past it would claim a state it never recorded. Only another
live runtime holding the same session's history makes an edit wait. If a personal runtime stops before the final snapshot, recovery leaves its
file edits intact and discards only the unfinished checkpoint metadata. Earlier
completed checkpoints still apply their member-edit conflict checks. Company checkpoint
operations run inside the existing sandbox; company history lasts for the runtime.

If the browser loses a restore response, **Check result again** sends the same
request key. The pending request survives reload in the same browser tab; reload
never submits it automatically. Keep that tab until the result is known. If the
browser cannot save the pending request, it refuses a new restore. An unconfirmed
result may mean files already changed: inspect them before continuing. Checking
the same request does not automatically repeat an uncertain file operation. If
only some files changed or the history save failed, the retained checkpoint can
report a conflict; inspect and resolve the files before a fresh restore attempt.


## Try the complete workflow

Use a disposable Git project with an initial commit and a passing test command.
For personal mode, open it in `piagent dashboard`. For company mode, select its
company conversation; the terminal steps require a Linux/WSL company Gateway
with a working sandboxed PTY. On macOS, check the unavailable notice instead;
that does not qualify the terminal steps.

1. Open a tracked file in Files, make a small change and save with Cmd/Ctrl+S.
2. Open Terminal, run the project's test command and inspect its exit status.
3. Keep a different tracked file open. Ask the agent to read and edit that file
   using edit/write. After the turn, inspect the added and removed inline lines.
4. Choose Keep and check that the file content stays unchanged. Ask for a second
   turn creating a small new file. Avoid shell edits for this attribution check.
5. On the first agent turn, choose Restore before this turn. Check that the
   preview lists both turns and both files, then confirm.
6. Verify that the original file is restored, the new file is removed, and your
   saved change from step 1 remains. HEAD and the staging area stay unchanged.

The `ide-editor-terminal` soak scenario separately exercises guarded editor saves
and terminal tests through the WebUI protocol. Its oracle self-check and transport
tests do not by themselves prove a completed run against a live model.
