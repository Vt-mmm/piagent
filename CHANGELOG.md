# Changelog

Every release of Pi Agent Platform (`@piagent/platform`), newest first. Versions follow semantic versioning; prereleases and builds that were tagged but never published are marked.

This file is generated from `docs-site/releases.json` by `node scripts/build-docs-site.mjs`, which also renders the [Changelog page](https://piagent.io.vn/en/whats-new). Edit the JSON, not this file. When publishing a tag, copy the version's block into the GitHub Release.

## v1.48.4 - 2026-10-30

**/reload keeps a company Terminal working; a new release never interrupts your next message.** Tools keep working after /reload in piagent studio, an update requested before /reload is still taken, and a Terminal waits for a quiet moment before it loads a new release.

### Fixed

- /reload in piagent studio no longer breaks the conversation: tools stopped with a stale context error after it.
- A message typed right after stopping a run with Esc is no longer lost: a Terminal loads a new release only after 10 quiet seconds with an empty input.
- An update requested before /reload is still taken, and a request already taken does not reload the Terminal a second time.

## v1.48.3 - 2026-10-30

**The agent sends pictures and files into the chat; reviews run across several repositories.** Answers show pictures and file cards in place, an SVG opens as a picture, attached images are large and open full size, and a folder of repositories gets its review.

### Added

- The agent sends a picture or file into the chat with ![name](path): a picture is drawn in place and opens full size, any other file is a card to open or download.

### Improved

- An SVG opens as a picture with View code beside it, and every open file has Download.
- An image attached to a message is a large thumbnail that opens full size, on the new conversation page too.

### Fixed

- Review no longer fails with not_git in a folder holding several repositories: changes made by commands, committed or not, are found in each repository.
- A review stopped by an update under a running conversation says so and asks to reopen it; an unnamed failure keeps its redacted words in the local log.

## v1.48.2 - 2026-10-30

**Terminals load a new release without closing; only the member waives checks.** After an update every open Terminal moves to the new release when idle and keeps its conversation, and a team's required checks can be skipped only by the member, on a card.

### Added

- piagent reload: every open Terminal (piagent and piagent studio) loads the installed release when idle and keeps its conversation; piagent-update asks for it after installing.
- Only the member can skip the checks a team requires: the agent asks on an approval card, once, for the code as it is then; later changes are checked again.

### Improved

- A Terminal running a task is never cut off: it loads the new release when the task finishes, and its footer says it is waiting.
- A turn whose checks the member skipped says so in its status, apart from a turn where no check ran; a push still asks as in every mode.

## v1.48.1 - 2026-10-30

**Faster first replies on the dashboard and an instant Enter in the Terminal.** New dashboard conversations start on the model and thinking level you use in the Terminal, and sending a message no longer waits on repository checks or disk flushes.

### Improved

- Pressing Enter shows your message right away: repository status is read in the background between turns, not while the message waits to appear.
- Live session events are written without a disk flush per event, which removes a pause before each message and each streamed update.

### Fixed

- A new dashboard conversation starts on the model and thinking level set in the Terminal, instead of always the highest reasoning model, so a short question gets a short wait.
- The first message of a new dashboard conversation is always sent, including on models without a thinking mode; it no longer stays behind a "session was created" notice.

## v1.48.0 - 2026-10-30

**Bypass stops at the handoff: every mode asks before work leaves the machine.** Pushes, pull requests, publishes and deploys are always approved by you, commands are checked against a full shell syntax tree, approvals gain session and stop answers, and the dashboard streams more smoothly.

### Added

- Approvals offer four answers: allow once, allow the same exact action for the session, deny, and deny and stop the turn. A handoff is always approved one at a time.
- Projects can refuse commands with autoDeny in .pi/piagent-profile.json. The rules hold in every mode, Bypass included; terminate also ends the agent's turn.

### Improved

- Smoother dashboard: a streaming answer redraws only its last paragraph, sidebar rows redraw only when they change, and a dropped connection is noticed and restored sooner.

### Fixed

- Approval cards, the dashboard, the terminal and the docs describe each access mode exactly as it behaves; personal sessions are no longer labelled as sandboxed.

### Security

- Every access mode asks before work leaves this machine: git push in any spelling, pull requests and merges, releases, publish, deploy, registry push, ssh and cloud tools, uploads.
- Bypass runs the work without asking and stops at the handoff, in personal and company sessions alike, including run_on_host with your sign-in and MCP tools that write outside.
- Commands are read by the policy scanner and a shell syntax tree: a push or a destructive delete inside if/then, a function, case, bash -c, eval or a heredoc is caught.

## v1.47.0 - 2026-10-29

**Company sessions use your MCP servers and drive iOS and Android simulators.** Jira, GitHub and every MCP server you set up for Piagent now work in company sessions, and the agent builds, runs, screenshots and tests mobile apps on simulators itself.

### Added

- Company sessions load the MCP servers set up for personal Piagent, with the same logins. Repository-defined servers still need approval; results reach the agent as data.
- The atlassian preset adds Jira and Confluence Cloud: piagent-mcp --preset atlassian, then /mcp-auth atlassian with your own Atlassian login.
- run_on_simulator boots simulators, builds, installs and launches apps, runs XCUITest, takes screenshots and reads logs: xcrun simctl, xcodebuild, adb, emulator, gradlew, flutter, expo.

### Security

- run_on_simulator refuses other programs, ;, &, $( ) and files outside the project. Full access and Bypass run it, but still ask when a command reaches credentials.

## v1.46.4 - 2026-10-29

**One subagent instead of a refused request; update reads a commented models.json.** Company sessions no longer loop on a refused subagent call, and the update no longer stops when the Pi model list file has comments.

### Improved

- A model-list setup problem no longer stops the whole install: it warns, names the file and gives the command to run again.

### Fixed

- An agent asking for 2–3 subagents the member did not ask for was refused, and some models retried until the member stopped the turn. One subagent now runs, and the agent is told why.
- piagent-update failed when models.json had // comments, which Pi allows. It reads the file as Pi does and leaves a commented file unchanged.

## v1.46.3 - 2026-10-29 (not published)

**One subagent instead of a refused request; update reads a commented models.json.** Tagged but not published: a release title over the page limit failed the release check. Superseded by 1.46.4.

### Improved

- A model-list setup problem no longer stops the whole install: it warns, names the file and gives the command to run again.

### Fixed

- An agent asking for 2–3 subagents the member did not ask for was refused, and some models retried until the member stopped the turn. One subagent now runs, and the agent is told why.
- piagent-update failed when models.json had // comments, which Pi allows. It reads the file as Pi does and leaves a commented file unchanged.

## v1.46.2 - 2026-10-29

**A message sent after an answer shows at once; the WebUI streams word by word.** The terminal takes the next message as soon as an answer ends, and the WebUI shows an answer while the model writes it instead of once its paragraph ends.

### Improved

- The WebUI shows an answer word by word while the model writes it; a one-paragraph answer appeared only once complete (first text at about 1.5 s, now 0.4 s, measured locally).

### Fixed

- In a folder of repositories, a message sent right after an answer reached the terminal 1–2 s late: Pi waited for the PIAGENT panel's working-tree scan. The panel now refreshes afterwards.

### Security

- Streaming holds back a line's last words, so a secret written over several words (Authorization: Basic …, password: …, --token …, a quoted value) is redacted whole.

## v1.46.1 - 2026-10-28

**Objections on the record, one review per turn, parallel subagents on request.** The company harness keeps one ledger of helper objections and the main agent's decisions, reviews once per turn, and runs 2–3 helpers of one role in parallel only when the member asks.

### Added

- Objections to a brief, review findings and failed claims share one ledger; the main agent records each decision with resolve_objection, and a wrong-premise objection blocks edits until decided.
- One helper per role by default; when the member asks for 2–3 of one role, they run in parallel, each on its own grant with Agent Studio 0.50.0 and Agent Watch 0.15.17.

### Improved

- Review runs once per turn: a required review is the harness's own, a re-review after a fix reads only the files changed, minor findings are only listed.
- The company terminal shows the checklist and what each running subagent is doing above the input.

### Fixed

- piagent studio installs fd on first start, so @ completion lists files and folders; it was never downloaded, even with fd under /opt/homebrew/bin.

Requires: Agent Studio 0.50.0 and Agent Watch 0.15.17 (Windows 0.1.18) for parallel subagents.

## v1.46.0 - 2026-10-28

**Piagent runs from its own Pi home and your own pi stays stock.** Piagent installs into ~/.piagent/agent and opens with `piagent`. Plain `pi` no longer loads Piagent, its add-ons, model list or footer panel.

### Breaking changes

- Piagent installs into its own Pi home, ~/.piagent/agent, and opens with `piagent`. Plain `pi` in ~/.pi/agent stays stock.

### Added

- A first install in a terminal asks which add-ons to install and whether to reuse your pi login; flags answer up front.
- `piagent restore-pi --apply` moves an older install out of ~/.pi/agent with backups; the installer does it on update.

### Fixed

- Pi's built-in mcp is turned off in Piagent's home when pi-mcp-adapter is installed, so /mcp no longer clashes.

Requires: Agent Watch 0.15.16 to list Piagent's personal sessions.

## v1.45.0 - 2026-10-28

**Files and images in a prompt follow the read policy, and the terminal stays responsive.** pi @file can no longer send a protected file to the model, images attach the way you add them, and a prompt in a folder of repositories no longer freezes the terminal.

### Added

- Images attach when named with @path or @"path", pasted with Ctrl+V, or dropped on the terminal; a skipped image says why and how to grant its folder.

### Improved

- In a folder of repositories a prompt no longer freezes the terminal for seconds: the change check asks Git and the inspector scans in the background.

### Fixed

- An image passed as pi @image.png is attached once, not twice.

### Security

- pi @file arguments follow the read policy: a protected file (.env) or one outside the project reaches the model as a withheld note, and its image is dropped.

## v1.44.4 - 2026-10-28

**Company conversations come back in Herdr panes.** In Herdr (on Windows: inside WSL), a company pane reports its state and reopens the same conversation after Herdr restarts, with piagent studio --session.

### Added

- piagent studio --session <file> reopens a company conversation; only a file of the member’s own store is accepted (managed-session-outside-store otherwise).
- A company conversation in a Herdr pane reports working, waiting or idle to Herdr, which resumes it with piagent studio, not personal pi. Needs Herdr 0.9.2+.

### Fixed

- WSL/Linux: personal Pi no longer opens a company conversation that has no turn yet, and piagent studio --web opens the browser (wslview/explorer.exe).

## v1.44.3 - 2026-10-28

**Prompt injection cannot quietly read the system.** Text in a page, file, memory or helper answer can no longer send data to an unknown site, read credentials in Bypass or steer the agent without the member seeing it.

### Security

- web_fetch reads documentation and registry sites freely; another site is asked about once per conversation, and an address there with a query or fragment every time.
- Helper answers and team memory results reach the agent inside a data fence it cannot close; the agent never shows its configuration or credentials or asks for a secret on their word.
- In Bypass, run_on_host still asks when a command reaches credentials: ~/.ssh, ~/.pi, .env, auth.json, keys, the Keychain or the environment.

## v1.44.2 - 2026-10-28

**The company harness follows the size of a change.** A small change ends after its checks without a review; a risky one has its checks and review required. The main agent may keep a few quick web lookups beside the research helper.

### Added

- workflow.main_web_lookups (0 to 5) lets the main agent make that many quick web_search or web_fetch calls per message beside the research helper.

### Improved

- Risk lanes, on by default: a change of at most 2 files and 40 lines that touches no sensitive file ends after its checks, without the reviewer. workflow.lanes: false turns them off.
- A risky change (migration, auth, CI, dependency or AGENTS.md file, a complex request, over 12 files or 400 lines) must pass its checks and review even where they are only suggested.

## v1.44.1 - 2026-10-28

**Your own Pi stays, pick a Terminal style, add skill repositories.** A member who runs a newer Pi keeps it while Piagent runs its own pinned copy; /style picks the Terminal's look; piagent skills add brings in skill repositories such as mattpocock/skills.

### Added

- /style picks the Terminal's look: Pi's system, dark and light, or Piagent's ocean, paper, contrast and focus. The company Terminal remembers the pick.
- piagent skills add mattpocock/skills adds a GitHub skill repository at one commit; its skills work as /skill:name in Pi, the company Terminal and the dashboard.

### Fixed

- Setup, install and update no longer replace a member's newer pi (such as 1.4.0) with the pinned 1.3.0: Piagent keeps its own copy in ~/.piagent/pi-host for company sessions, the dashboard and piagent pi.
- piagent-uninstall --with-host removes Piagent's private Pi and leaves a member's own newer pi in place.

### Security

- Five undici advisories published on 2026-10-27 are accepted until 2026-11-07: undici 8.10.2 is pinned by every Pi host and fixed in 8.12.2.

## v1.44.0 - 2026-10-28 (not published)

**Your own Pi stays, pick a Terminal style, add skill repositories.** Tagged but not published: new undici advisories in the Pi host stopped the runtime audit. Superseded by 1.44.1.

### Added

- /style picks the Terminal's look: Pi's system, dark and light, or Piagent's ocean, paper, contrast and focus. The company Terminal remembers the pick.
- piagent skills add mattpocock/skills adds a GitHub skill repository at one commit; its skills work as /skill:name in Pi, the company Terminal and the dashboard.

### Fixed

- Setup, install and update no longer replace a member's newer pi (such as 1.4.0) with the pinned 1.3.0: Piagent keeps its own copy in ~/.piagent/pi-host for company sessions, the dashboard and piagent pi.
- piagent-uninstall --with-host removes Piagent's private Pi and leaves a member's own newer pi in place.

## v1.43.9 - 2026-10-27

**Every installed skill, and files the agent hands back.** Skills from Claude and Codex plugins, such as superpowers, reach the agent; a file the agent links opens in the web view; the folder picker works on Windows.

### Added

- A file the agent links in its answer opens in the explorer: code at its line, images as a picture, PDF and office files as their text.

### Improved

- Skills and commands of the member's Claude and Codex plugins are listed and readable, the newest version of each; /plugin:skill works too.

### Fixed

- Choosing a project folder opens the system folder picker on Windows again, also from a dashboard started in the background.
- A turn that changed only documentation or Spec Kit files is not sent back to run the repository checks, and a declined approval for a check is not asked again.
- An answer the agent repeats after the harness sends it back is shown once, not once per round.
- On Linux and Windows (WSL2), checks find a JDK outside PATH: SDKMAN, /usr/lib/jvm or ~/.jdks.

## v1.43.8 - 2026-10-27 (not published)

**Every installed skill, and files the agent hands back.** Tagged but not published: a new Linux-only test read the wrong field on CI. Superseded by 1.43.9.

### Added

- A file the agent links in its answer opens in the explorer: code at its line, images as a picture, PDF and office files as their text.

### Improved

- Skills and commands of the member's Claude and Codex plugins are listed and readable, the newest version of each; /plugin:skill works too.

### Fixed

- Choosing a project folder opens the system folder picker on Windows again, also from a dashboard started in the background.
- A turn that changed only documentation or Spec Kit files is not sent back to run the repository checks, and a declined approval for a check is not asked again.
- An answer the agent repeats after the harness sends it back is shown once, not once per round.
- On Linux and Windows (WSL2), checks find a JDK outside PATH: SDKMAN, /usr/lib/jvm or ~/.jdks.

## v1.43.7 - 2026-10-27 (not published)

**Every installed skill, and files the agent hands back.** Tagged but not published: the public wording check stopped the release on a product name in the notes. Superseded by 1.43.9.

### Added

- A file the agent links in its answer opens in the explorer: code at its line, images as a picture, PDF and office files as their text.

### Improved

- Skills and commands of the member's Claude and Codex plugins are listed and readable, the newest version of each; /plugin:skill works too.

### Fixed

- Choosing a project folder opens the system folder picker on Windows again, also from a dashboard started in the background.

## v1.43.6 - 2026-10-27

**Watch the agent's edits while it runs.** Changes and Review follow a running turn, so a run going wrong can be caught and stopped early, and a turn still running never looks finished.

### Improved

- The Workspace panel lists changed files and opens Review while the agent runs, refreshing every few seconds; Review follows the run too.

### Fixed

- An answer the harness sends back to run checks is marked as interim, and the turn keeps showing that it runs, with Stop, until the checks finish.

## v1.43.5 - 2026-10-27

**Image previews and office attachments.** Sent images show as pictures, spreadsheets and slide decks attach directly, and screenshot-heavy tasks no longer stop on Studio's request size limit.

### Added

- Attached and sent images show as pictures in the conversation and open full size; the composer chip shows a thumbnail.
- Attach .xlsx, .xlsm, .pptx, .odt, .ods, .odp and .rtf: sheets come through as tab-separated rows and slides in order with their notes, without a converter.

### Fixed

- A company task with many screenshots no longer fails with request_too_large: each request resends only the newest images within 2 MiB; older ones become a note.
- A streamed answer from a turn with tools starts a new paragraph for each model message instead of running sentences together.

## v1.43.4 - 2026-10-26

**Your workflow, with adaptive backend and frontend support.** Company conversations discover project surfaces and reuse the member’s skills, plans and requirement sources without imposing another methodology. Existing safety and approval boundaries stay in place.

### Added

- Bounded discovery maps frontend/backend packages and repositories inside the conversation folder and suggests relevant local checks, refreshed each task.
- Optional workflow context remembers task-specific canonical requirement, plan and task references across reopening, shares them read-only with helpers, and supports switching or clearing.

### Improved

- Lifecycle guidance adapts to the chosen workflow and stopping point, without mandatory spec files or automatic release gates. Skills never grant access or waive verification, review or deployment approval.

### Fixed

- History loading rechecks the current scroll position and responds to upward scrolling, preventing stale observer events from loading extra pages or leaving history stuck.
- Review runs in a folder holding several repositories: each changed file is reviewed in its own repository, and a file outside any repository is named as not reviewed.

## v1.43.3 - 2026-10-26 (not published)

**Your workflow, with adaptive backend and frontend support.** Tagged but not published: Linux WebUI history checks exposed scroll and observer races. Superseded by 1.43.4.

### Added

- Bounded discovery maps frontend/backend packages and repositories inside the conversation folder and suggests relevant local checks, refreshed each task.
- Optional workflow context remembers task-specific canonical requirement, plan and task references across reopening, shares them read-only with helpers, and supports switching or clearing.

### Improved

- Lifecycle guidance adapts to the chosen workflow and stopping point, without mandatory spec files or automatic release gates. Skills never grant access or waive verification, review or deployment approval.

## v1.43.2 - 2026-10-26 (not published)

**Your workflow, with adaptive backend and frontend support.** Tagged but not published: workflow prompt wording matched a forbidden command in the native-session regression test. Superseded by 1.43.4.

### Added

- Bounded discovery maps frontend/backend packages and repositories inside the conversation folder and suggests relevant local checks, refreshed each task.
- Optional workflow context remembers task-specific canonical requirement, plan and task references across reopening, shares them read-only with helpers, and supports switching or clearing.

### Improved

- Lifecycle guidance adapts to the chosen workflow and stopping point, without mandatory spec files or automatic release gates. Skills never grant access or waive verification, review or deployment approval.

## v1.43.1 - 2026-10-26 (not published)

**Your workflow, with adaptive backend and frontend support.** Tagged but not published: a release-note bullet exceeded the documentation length limit. Superseded by 1.43.4.

### Added

- Bounded discovery maps frontend/backend packages and repositories inside the conversation folder and suggests relevant local checks, refreshed each task.
- Optional workflow context remembers task-specific canonical requirement, plan and task references across reopening, shares them read-only with helpers, and supports switching or clearing.

### Improved

- Lifecycle guidance adapts to the chosen workflow and stopping point, without mandatory spec files or automatic release gates. Skills never grant access or waive verification, review or deployment approval.

## v1.43.0 - 2026-10-26 (not published)

**Your workflow, with adaptive backend and frontend support.** Tagged but not published: the documentation wording gate blocked the release. Superseded by 1.43.4.

### Added

- Bounded discovery maps frontend/backend packages and repositories inside the conversation folder and suggests relevant local checks, refreshed each task.
- Optional workflow context remembers task-specific canonical requirement, plan and task references across reopening, shares them read-only with helpers, and supports switching or clearing.

### Improved

- Lifecycle guidance adapts to the chosen workflow and stopping point, without mandatory spec files or automatic release gates. Skills never grant access or waive verification, review or deployment approval.

## v1.42.1 - 2026-10-25

**Faster dashboard loading and less workspace hashing memory.** Static code and styles transfer compressed; secondary interfaces load when needed, with recoverable loading errors.

### Improved

- The local dashboard serves gzip JS/CSS to supporting browsers and reuses the compressed bytes.
- Gateway and inspection interfaces load separately; Settings failures stay within a dismissible dialog. Theme and server preferences are preserved.
- Hashing small workspace files allocates a buffer sized to the file while retaining full content and file-identity checks.

### Fixed

- The Gateway starts on native Windows and persists signed workspace receipts without applying POSIX permission bits or directory fsync to Windows files.

## v1.42.0 - 2026-10-25

**A redesigned dashboard and older messages that load without jumping.** The dashboard gets one design scale and every theme everywhere; older messages load as you scroll up and the message you are reading stays put.

### Added

- Older messages load on their own as you near the top, and the message being read no longer moves when a page is added above it.

### Improved

- All 13 colour themes now reach the diff, approval, question and document views; header, sidebar, composer and new chat page are redesigned.
- A running turn shows one moving indicator at a time: the step's spinner, the streaming caret, or a thinking spinner.
- New website and README with an Update & uninstall guide; release notes now come from one file that also writes `CHANGELOG.md`.

### Fixed

- History showed raw markdown for a moment and then reflowed; it now appears formatted from the first frame.
- Loading many older pages silently dropped the newest messages; the window now holds 1,000 items and offers a way back to the newest.

## v1.41.0 - 2026-10-24

**Front-end change reports with before/after screenshots.** A new skill turns a front-end task into a report with framed before/after screenshots, business and logic changes and check results, shown in the dashboard.

### Added

- The `fe-change-report` skill captures old and new pages headless on the same data and frames each change with a numbered red box on both.
- The agent runs the project's checks and full E2E headless, naming baseline failures, and writes what changed in business, logic and on screen.
- Documents draws `reports/fe-change/<slug>/report.json` as the report, with zoom per frame, other screen sizes and a full-screen view.
- The scripts use the project's own Playwright and add no dependency; they write one self-contained `report.html` with no scripts, to send to anyone.

### Security

- The report is drawn from data, never from the HTML file, and only its PNG screenshots are served, so the dashboard still renders no model markup.

## v1.40.0 - 2026-10-24

**Local projects are reported to Studio too.** Company conversations in folders without a remote report a local project to Studio, every run reports, and members see every kind of project warning.

### Added

- A folder without a readable remote is reported as a local project, by its Git root commit or by a hash; its path never leaves the computer.
- A Git project's local key is the same on every computer with that history, including clones and checkouts without an `origin` remote.

### Improved

- Every run reports its projects, not only a conversation's first, so Studio counts each use and knows which computers never report.
- Members see a line for every warning: another team's project, one outside the team's list, an unregistered project or an unreadable folder.
- A folder holding several checkouts reports each one, up to six, and a local project is named by its folder.

### Security

- Three dependency advisories in the Pi host are accepted until 2026-11-07: denial of service and a check bypass Pi does not use, no data exposure.

Requires: Agent Studio 0.40.0.

## v1.39.0 - 2026-10-23

**Warnings when a team key is used outside its team.** Studio learns which repositories a company conversation works in and warns when a team key is used outside its team; the dashboard keeps its language and theme.

### Added

- Company conversations tell Studio their repositories, using the same `host/path` keys team memory already sends.
- Administrators see the warnings in Logs → "Sai project"; the member reads one line above the composer and in `piagent studio`.

### Improved

- Nothing is blocked, and team memory works as before.

### Fixed

- The dashboard went back to the default language and colour theme on every restart; it now keeps both.

Requires: Agent Studio 0.39.0.

## v1.38.2 - 2026-10-23

**Folder tree, colour themes and an editor that stays in view.** The files panel becomes a folder tree, 13 colour themes arrive, and the editor and terminal stay pinned while the conversation scrolls.

### Added

- Colour themes in Settings → Appearance or the command palette (⌘K) colour the interface, the editor's syntax and the terminal.

### Improved

- On wide screens the editor and terminal stay pinned under the header while the conversation scrolls; a splitter sets the editor's width.
- The files panel is a folder tree: folders open in place, the open file is highlighted, and New file starts in the last folder chosen.
- The Files/Terminal switches stay pinned on every width; on phones the folder tree is narrower and the editor's actions fit on one line.

## v1.38.1 - 2026-10-23

**Published release of v1.38.0.** v1.38.0 failed its release checks on two tests and was never published; v1.38.1 is the same release with those tests fixed.

### Improved

- Two release tests now pass on Linux and on slow runners, so the editor, terminals, review, checkpoints and Bypass of v1.38.0 ship here.

## v1.38.0 - 2026-10-23 (not published)

**Piagent becomes an editor, and Bypass asks nothing.** Files, terminals, inline review and checkpoints in the dashboard, and a Bypass mode that asks nothing, in company conversations where the Harness allows it.

### Breaking changes

- Company conversations have Ask first, Full access (formerly called Bypass) and Bypass, offered only when the Harness allows it.

### Added

- The `bypass` mode (`/permission bypass`, `piagent-auto --bypass`) turns every gate off; output is still redacted and `/undo` still works.
- The dashboard opens, edits, saves, renames and deletes project files, with Cmd/Ctrl+P, search and conflicts when a file changed on disk.
- Project terminals in the dashboard; company terminals run in the sandbox, on macOS too, and never on the host.
- Inline review of the agent's hunks with Keep and Revert, and Timeline restore with a preview, sharing checkpoints with `/undo`.

### Fixed

- A checkpoint that could not be taken blocked every edit; it no longer does, and snapshots take about 0.5 s instead of 35 s on 4,000 files.

Requires: Agent Studio 0.38.0 and Agent Watch 0.15.14 (Windows 0.1.17) for the company Bypass level.

## v1.37.1 - 2026-10-22

**Run closes and helper reports Studio can trust.** A retried close counts only when it reaches Studio, helpers keep their answers, and outbound requests refuse every IPv6 form of a private address.

### Fixed

- A close retried after a brief failure could be recorded without reaching Studio; it now counts only when Studio receives it.
- A helper whose close failed for a moment was turned into a failure; it now keeps its answer, and its report is resent after passing errors.
- Team memory merged failures of two commands of one executable into one lesson; the whole command is now the key.
- Skill feedback mixed skills with alike names such as `a/b` and `a_b`; each skill name now keeps its own file.

### Security

- The `web_fetch` tool and the package proxy let some IPv6 forms of a private address through; every such form is now refused.
- With a company upstream proxy (`HTTPS_PROXY`), the package proxy now checks each destination itself instead of leaving it to the upstream.

Requires: Agent Watch 0.15.11 (Windows 0.1.16).

## v1.37.0 - 2026-10-22

**A cut answer no longer stops a long task.** An answer cut mid-stream behind Studio is asked again and the task goes on, and `piagent studio --rpc` lets a script drive a company conversation.

### Added

- New `piagent studio --rpc` runs one company conversation over Pi's RPC protocol on stdin/stdout, with several messages and `ask_user`.
- A long-task soak lane in the repository drives the real company agent through 45–150-minute tasks with a simulated member.

### Fixed

- An answer cut mid-stream showed "the request could not be sent" and stopped a long task; it is now asked again and the task goes on.
- The company Terminal no longer exits with an error when a conversation closes right after a turn while Git still reports branch status.

## v1.36.1 - 2026-10-22

**A brief Agent Watch failure no longer stops a task.** When Agent Watch briefly cannot reach a running Studio, Piagent asks again for up to 3 minutes instead of stopping the task.

### Improved

- Each wait is logged locally and reported to Studio in Logs → "Mất kết nối"; a refused key or report still fails at once.

### Fixed

- One failed grant renewal through Agent Watch stopped a 25-minute task; it is now asked again, waiting longer each time, for up to 3 minutes.
- Closing the round's run goes through the same wait, so a passing gateway error no longer fails a turn whose work is done.

## v1.36.0 - 2026-10-21

**Team memory learns from what went wrong.** Memory learns from member feedback and repeated errors, keeps only completed tasks that add something, and proposes failing skills for review.

### Added

- What memory hands a round goes back to Studio with it, so Studio rates notes by the member's next words and stops briefing wrong ones.
- A command that fails the same way twice in a round becomes a lesson that keeps the first error line, with no guessed cause.
- When 3 of a skill's last rounds failed, Piagent writes a proposal to `.pi/piagent-state/skill-proposals/`, at most weekly; it never edits skills.

### Improved

- Repository memory skips completed tasks that change only build output, caches, logs or Piagent's state, or repeat files already known.

Requires: Agent Studio 0.37.0.

## v1.35.1 - 2026-10-21

**A passing model provider failure no longer stops a long task.** A provider error in the middle of an answer is asked again, and a round cut by such a failure goes on by itself after a pause.

### Improved

- Where that retry cannot run, the next round starts after a pause and tells the agent why, up to 8 times per member message (about 23 min).
- A round that ends well resets the count, Stop ends the pause, and after the last attempt the turn fails with its reason.
- Every retry is recorded in the member's local log, so why a task stopped or went on can be read back.

### Fixed

- A provider error after a tool step stopped a long task until the member wrote again; it is now asked again 2 and 4 s later.

## v1.35.0 - 2026-10-21

**Long company tasks go on across Studio updates.** When Studio stops, restarts or updates mid-task, Piagent waits for it and goes on instead of failing, and a dashboard turn can run for 24 hours.

### Added

- When Studio is away, Piagent reads its heartbeat and asks again once it is back, with no time limit; Stop ends the wait.
- Every wait is logged locally and reported to Studio, which lists it with its cause in Logs → "Mất kết nối".

### Improved

- A round the dashboard cannot replay starts again by itself and tells the agent Studio was updated, so it continues where it was.
- One member message can run for 24 hours in the dashboard (it was 6); the 15-minute silence limit stays.
- A key, quota or policy failure still fails at once, as before.

Requires: Agent Studio 0.36.0.

## v1.34.3 - 2026-10-20

**Agent Watch notifies for company conversations.** Company conversation states were written where Agent Watch does not read, so it never notified; they are now written where it reads.

### Fixed

- Agent Watch never notified for company conversations; their states now go to `~/.pi/agent/status/company`, without prompts or answers.

## v1.34.2 - 2026-10-20

**Helper outcomes reach Studio.** In 1.34.1 Studio refused helper reports sent with an outdated token, so no outcome was recorded; reports now go with the current token.

### Fixed

- Helper reports were refused after a token renewal and no outcome was recorded; they now use the helper role's current token.

## v1.34.1 - 2026-10-20

**Helper outcomes, line review and Agent Watch notifications.** Helpers report how their work ended, line comments on a diff go to the agent, and Agent Watch notifies when a conversation needs you.

### Added

- Each helper reports how it ended: succeeded, failed, cancelled or unverifiable; Studio shows it in Logs → Lượt agent.
- In Source Changes, click a line number to comment; comments on several files go to the composer as one message with `file:line`.
- The review helper's findings show under the line they name, and findings without a line under their file.
- Conversation states are written for Agent Watch notifications, holding only the title and project name, never prompts or answers.
- The `delegate` tool takes optional target, change, constraints, ownership and acceptance fields, which head the helper's brief.

### Improved

- Piagent asks Studio hourly which operations it serves and uses newer ones only when listed; an older Studio keeps today's behaviour.

Requires: Agent Studio 0.34, Agent Watch 0.15.9 (Windows 0.1.15).

## v1.33.0 - 2026-10-20

**Company and personal sessions run on Pi 1.3.0.** `piagent-setup` and `piagent-update` move Piagent from Pi 0.87.1 to Pi 1.3.0, which refuses malformed tool calls and retries gateway errors.

### Breaking changes

- Your personal `pi` also becomes 1.3.0: theme `$schema` references changed, and `kimi-coding` base URL overrides must end in `/v1`.

### Improved

- A tool call with malformed JSON arguments is refused and shown to the model instead of running with the fields parsed before the error.
- Gateway errors are retried, a resumed session keeps its active tools, and switching model drops the previous model's thinking.
- GPT-6.1 Sol keeps its reviewed 272k window in company sessions, where use above 272k is priced at twice the rate.

### Fixed

- A run started by a custom message now gets the usual system prompt and starts no extra turn, task or context pack.

### Security

- Three accepted dependency advisories are resolved: Pi 1.3.0 installs the fixed version.

Requires: Pi 1.3.0.

## v1.32.1 - 2026-10-19

**Bypass survives a reload, and a tab in use stays signed in.** Bypass and Fast turned on right after a reply are kept, the access button follows the open conversation, and a tab in use is no longer signed out.

### Fixed

- Turning on Bypass or Fast right after a reply was refused, so a reload showed "Hỏi trước"; it is now resent against the latest state.
- Opening another conversation in Bypass showed "Hỏi trước"; the access button and Settings → Access now follow the open conversation.
- A browser session ended 8 hours after launch even while in use; it now renews for up to 7 days, and only a tab unused for 8 hours signs out.

## v1.32.0 - 2026-10-19

**Failed or stopped company streams end at Studio too.** When a company stream fails or you press Stop, Piagent asks Studio to end the request, so the conversation's account is free for the next one.

### Improved

- New failure messages for an over-long answer, a cancelled request and a superseded one; an over-long answer is asked again.

### Fixed

- A dropped stream could keep running at Studio for 10 minutes, so every retry was refused as "account busy"; Studio is now told to end it.

Requires: Agent Studio 0.32.0.

## v1.31.1 - 2026-10-19

**`memory_ask` is there from the first conversation after an update.** The first company conversation after Agent Studio 0.30.0 arrived had no `memory_ask`; it is now offered whenever the conversation has team memory.

### Improved

- On a Studio without it, `memory_ask` says to use `memory_search`, and memory stays on.

### Fixed

- The `memory_ask` tool was missing from the first company conversation after a Studio update; it is now offered whenever team memory is on.

## v1.31.0 - 2026-10-19

**Team memory follows the work.** Team rules lead the brief, memories from the current branch and folders are preferred, and the new `memory_ask` answers with sources.

### Added

- The brief starts with the team's rules, which override recalled memories.
- The new read-only `memory_ask` tool answers a question from team memory with its sources, for the main agent and helpers.

### Improved

- Each round carries its branch, folders, changed files and checks, so Studio prefers memories from the current branch and folders.
- An agent's "fixed" or "done" is a claim until a check passes, and turns stale when Git removes the files it named.
- Check results from piped commands such as `cmd | tail` now count as lessons, and Agent Studio 0.27–0.29 keeps working.

### Fixed

- Folders with several repositories, a remote not named `origin` and Git "dubious ownership" on WSL no longer turn memory off silently.

Requires: Agent Studio 0.30.0.

## v1.30.1 - 2026-10-18

**Company Terminal hides model names; clear message in the home folder.** The company Terminal shows roles instead of model ids, and `piagent studio` in the home folder now says why it cannot open there and what to do.

### Improved

- Pi's start-up warnings no longer point at /bug, which is off in company conversations, or name a model.

### Fixed

- The company Terminal showed the Harness's model ids in its header, footer and /model answers; it now shows roles, such as `Main agent • Rất cao`.
- Running `piagent studio` in the home folder wrongly said Agent Watch or Piagent had changed; it now says to open a project folder or use `--project`.

## v1.30.0 - 2026-10-18

**Large contexts over slow connections; a clearer company Terminal.** Model calls to Studio are gzip-compressed, about 3x smaller, and the company Terminal shows turn stats, running helpers and the Git branch.

### Improved

- Model calls of 64 KiB or more go to Studio gzip-compressed once Studio accepts it, about 3x smaller.
- Each turn's end notice in the company Terminal adds requests, tokens, time and output speed.
- The footer shows `Subagent n/m` and the Git branch; `memory_search` and `memory_page` results stay short, with Ctrl+O to show all.

### Fixed

- A slow upload that keeps sending is no longer cut at 15 s.
- Commands `/bypass status` and `/fast on` run on the first Enter, and `piagent studio` says it is joining Agent Watch before the Terminal draws.

Requires: Agent Studio 0.28.2.

## v1.29.0 - 2026-10-18

**Company Terminal shows the Harness and keeps work inside the company.** The company Terminal gets its own header, footer and plan checklist, blocks commands that send work outside, and Stop no longer breaks the next message.

### Added

- A company header shows team, Harness model and effort, review model, Ask first or Bypass, Fast, memory and release.

### Improved

- `/login`, `/model`, `/thinking`, `/settings` and their keys say the team's Harness decides instead of opening Pi's pickers.
- The footer shows the Harness's real model and effort with no USD cost, and the plan is drawn as a checklist.
- `/changelog` shows Piagent's release notes, and the loader reads “Đang chờ bạn trả lời” while a question waits.

### Fixed

- Stopping a turn while a command ran could break the next message; with the required Studio and Watch, the next message now starts a new run.

### Security

- `/share` and `/bug` are refused in the company Terminal, since both sent company conversations and code outside the company.

Requires: Agent Studio 0.28.1, Agent Watch 0.15.7 (Windows 0.1.14) for the Stop fix.

## v1.28.3 - 2026-10-18

**Agent Watch self-updates no longer break the company Terminal.** Right after Agent Watch updates itself on macOS, `piagent studio` and the dashboard wait for the new setup instead of failing for about a minute.

### Fixed

- `piagent studio` failed for up to a minute after Agent Watch updated itself; it now waits for the new setup and runs.

### Security

- The wait applies only when the changed file is still Agent Watch's own app, and every pinned path and hash is checked again first.

## v1.28.2 - 2026-10-18

**No setup error right after a Piagent update.** After a Piagent update, `piagent studio` waits up to 90 seconds for Agent Watch to rewrite the company setup instead of failing at once.

### Improved

- While waiting it says “Agent Watch đang cập nhật cấu hình…”, or that Agent Watch is not running; the dashboard waits as long.
- Update notes in the Terminal and the dashboard no longer tell members to import the configuration again by hand.

### Fixed

- `piagent studio` failed right after an update while Agent Watch had not rewritten the setup; it now waits, rechecks every hash and runs.

## v1.28.1 - 2026-10-18

**Company Terminal and personal Pi stop stepping on each other.** Personal Pi starts again when Piagent was loaded twice, old company entries are cleaned up, and company conversations stay in the company Terminal.

### Improved

- `piagent-update --check` reports the installed Pi package version and any personal Pi conflict.

### Fixed

- Personal `pi` exited without an answer when Piagent was loaded twice; `piagent-update` and the installer now remove the duplicate, with a backup.
- Old Agent Watch company providers and models in personal Pi are removed once a company binding exists; your own settings stay.
- Personal Pi refuses to continue a company conversation and says to open it with `piagent studio --project <folder>` and `/resume`.
- `/help` in the company Terminal lists commands locally instead of going to the agent, which even started a review.
- Stopping `piagent` from a script, editor or timeout now stops the company run under it instead of leaving it running.

## v1.28.0 - 2026-10-17

**Team memory v2: each round once, brief restored after compaction.** Each company round reaches team memory exactly once, the brief returns after compaction, and observed check recoveries are kept.

### Added

- After a compaction the agent gets a fresh brief for the latest request, and the conversation keeps exactly one brief.
- A round carries up to three observed check recoveries (fail, change, pass), redacted, never a guessed cause.

### Improved

- Rounds are queued on disk before sending, so a lost reply, a crash or two sessions never record a round twice or under another key.
- On Agent Studio 0.27.x rounds still reach memory, so either release order keeps memory growing.

### Fixed

- An empty or failed brief is no longer requested again every round, and closing a round waits at most 4.5 seconds.

Requires: Agent Studio 0.28.0.

## v1.27.1 - 2026-10-17

**Team memory keeps working while the agent calls the model.** Commits and memory searches made beside a model request no longer fail, so a repository's commits reach team memory again.

### Fixed

- Memory calls made beside a model request were refused on an expired token; they now renew the token and retry once.

Requires: Agent Studio 0.27.1.

## v1.27.0 - 2026-10-17

**Team memory: company agents remember what the team settled.** With team memory on, a new company conversation opens with a short brief of the repository's decisions, rules and work in progress.

### Added

- New company conversations open with a brief from the team's memory of the repository, kept in the conversation for the prompt cache.
- Each round (your words, the final answer, changed files; never tool output) goes back to memory redacted, and new commits once.
- The main agent gets `memory_search` and `memory_page`; helpers get a read-only `memory_search`.

### Improved

- Memory never fails or slows a turn: calls are bounded, and a team without memory gets no memory traffic or tools.

Requires: Agent Studio 0.27.0 with team memory turned on.

## v1.26.1 - 2026-10-16

**Rename a conversation while its turn runs.** Renaming a conversation mid-turn now takes effect, and a rename, fork or archive that fails says why in words.

### Improved

- A rename, fork or archive that still fails explains why in words, with the code at the end.

### Fixed

- Renaming a conversation from its menu during a turn showed an error and kept the old name; the rename now lands mid-turn.

## v1.26.0 - 2026-10-15

**Dashboard `/` commands, `/undo` and dev servers across turns.** Company conversations gain Terminal-style `/` commands in the dashboard, `/undo` for the last turn, long-running dev servers and instant type errors.

### Added

- Dashboard `/` commands such as `/new`, `/fork`, `/undo`, `/fast` and `/bypass` run locally, plus ⌘⇧O, ⌘/ and Esc shortcuts.
- `/undo` restores the files the agent's last turn changed, one turn at a time, without touching your index, HEAD or commits.
- On macOS a dev server or watcher started by the agent keeps running across turns in the sandbox, for up to 4 hours.
- After editing a TypeScript or JavaScript file, the agent gets that file's errors from the project's own TypeScript.
- `piagent studio --prompt <text> --json` writes the same event stream as `pi --mode json`.

### Fixed

- Fetching a repository with many branches stopped after 60 seconds; the download now has ten minutes.

## v1.25.0 - 2026-10-13

**When the machine lacks something, the agent asks and then runs.** A company conversation no longer gives up on a missing runtime, sign-in or stopped Docker: the agent asks for approval and carries on.

### Added

- `run_on_host` runs one approved command on your machine outside the sandbox, such as installing a runtime or `git push`; it always asks.
- `start_docker` asks to start an installed but stopped Docker and waits for it, so `run_with_docker` works in the same conversation.

### Improved

- Every sandbox failure names the way forward instead of “report it and stop”.
- Steps only you can do, such as a `sudo` password or an interactive sign-in, are asked with the exact steps and “done, continue” or “skip”.

### Fixed

- A turn that only read repositories with `git -C` was counted as a code change and asked for checks three times.

## v1.24.0 - 2026-10-13

**Choose Fast when a company conversation starts.** The new chat page offers a Fast switch when the team's Harness allows it, and the switch turns amber while on.

### Added

- “Fast: tắt / Fast: bật” next to the company model makes a new conversation run Fast from its first message.

### Improved

- The Fast switch in the header turns amber while on, since its calls count 2.5 times toward the quota.

## v1.23.1 - 2026-10-13

**Agent questions wait at the end of the conversation.** Questions and approvals now sit right above the composer, so a long turn no longer pushes them out of view.

### Improved

- The question card has larger text and roomier options, and “Let the agent decide” no longer outweighs “Send answer”.

### Fixed

- A long turn pushed a waiting question out of view; questions now come last and the page scrolls to them.

## v1.23.0 - 2026-10-13

**Fast mode for company conversations, tool failures sent to Studio.** Where the Harness allows it, a Fast switch gets faster GPT answers at 2.5× quota, and failed tool calls are reported to Agent Studio.

### Added

- Fast mode via the dashboard switch or `/fast on|off|status`: same GPT model and thinking, faster, tokens counted 2.5 times.
- Failed tool calls in company runs are reported to Agent Studio with secrets redacted and no prompts.

### Improved

- On Claude or API-key models Fast adds nothing, and a refused fast request falls back to standard speed with a note.

### Fixed

- After an admin changed the Harness, a new company conversation never sent its first message; it now starts at an allowed level.

Requires: An Agent Studio and Agent Watch that support the Harness Fast setting.

## v1.22.1 - 2026-10-12

**Dashboard no longer hangs on a slow file system.** A project on a Windows drive seen from WSL no longer leaves the dashboard stuck on “Opening Piagent…”.

### Improved

- On Windows, keep projects in the Ubuntu file system (`~/projects`); under `/mnt/c` or `/mnt/d` they work but stay slow.

### Fixed

- On Windows the dashboard could stay on “Opening Piagent…”; it now waits 15 seconds for the company runtime and opens anyway.
- Git gets 8 seconds per repository to list changed files; a slower one is shown without them and retried after 5 minutes.

## v1.22.0 - 2026-10-09

**Attach any source or text file.** Any text file can be attached under its own name, binaries are refused up front with an alternative, and messages with files show once.

### Added

- Attach `.html`, `.css`, `.ts`, `.py`, `.go`, `.sql` and any other text file, including `Dockerfile` or `Makefile`, under its own name.

### Improved

- Binary formats are refused before upload with what to send instead, such as .csv for spreadsheets or .pdf for slide decks.

### Fixed

- A message with a file showed twice after its turn, once with the raw file contents; now only your text and the file card show.

## v1.21.1 - 2026-10-09

**Turn on Bypass while a turn runs, and it stays on.** A company conversation can switch between Ask first and Bypass at any time, and the next commands follow the new choice.

### Improved

- A command already waiting keeps its Allow or Deny card, and the result of a switch shows in a notice at the top.

### Fixed

- Turning on Bypass while a command waited for approval looked done but did not take; it now applies mid-turn and is kept.

## v1.21.0 - 2026-10-09

**Decisions one card at a time, alerts from other conversations.** Questions and approvals show one card at a time, other conversations announce when they finish or wait for you, and Studio logs compactions.

### Added

- A toast says when another conversation finishes, fails, stops or waits for you, and “Mở” opens it.
- The sidebar marks conversations waiting for you or finished unseen, and the tab title counts what waits.
- Studio logs each context compaction of a company conversation with its reason and size before and after; no summary text is sent.

### Improved

- Questions and approvals show one card at a time with steps such as “Việc cần bạn quyết · 1/3”, main agent first.

## v1.20.0 - 2026-10-09

**Package installs in the company sandbox no longer ask.** Plain commands reach the usual package registries through a restricted proxy, long subagents keep running, and review reads earlier commits.

### Added

- Installs from npm and other common registries run without approval through a proxy that allows only those hosts.

### Improved

- Add your own registry hosts in `~/.piagent/sandbox-domains`, one per line; registry credentials stay out of the sandbox.
- Bypass runs `run_with_docker` without asking; pushes, deploys, registry logins and unclear deletes still ask.

### Fixed

- A subagent working longer than 15 minutes was stopped and the turn aborted; it now keeps running.
- The review subagent said “no patch” for work committed earlier; it now reads commits since a given commit, branch or `HEAD~N`.

## v1.19.0 - 2026-10-08

**Checklist tasks carried to the end, Docker in the company sandbox.** The Harness carries a checklist task to its end, every turn says how it ended, Docker is available for approved commands, and multi-repo folders work.

### Added

- When the Harness requires a plan, it sends the agent on to the next open checklist step until done, stopped or stalled.
- Every company turn ends with a status line such as “Hoàn thành · n/n bước”, with Continue when the task is not finished.
- `run_with_docker` runs one approved command with internet and Docker, for test databases, builds or container tests.
- A folder holding several repositories shows “N repo”, with each repository's branch and changed files.

### Improved

- Steps you postpone are marked deferred, never completed, and `./mvnw` and `./gradlew` reuse distributions already on the machine.

### Fixed

- A turn that committed its change counted as “no code changed”; checks and review now apply to committed work.

## v1.18.0 - 2026-10-08

**Switch Git branch from the dashboard, retries, Claude Haiku 5.5.** The branch in the dashboard becomes a switcher, passing model failures are retried before showing, and Claude Haiku 5.5 is available.

### Added

- The Git branch in the header and status bar lists branches to switch to, or creates a new one from the current commit.
- Claude Haiku 5.5 can be used in company conversations when Studio offers it, and joins the personal Claude model scope.

### Improved

- A branch switch waits while any conversation in that folder runs, and shows Git's own reason when Git refuses.
- A company answer cut off for a passing reason is retried up to twice before the failure shows; quota or key errors fail at once.

## v1.17.0 - 2026-10-08

**The dashboard shows each project's Git branch.** The dashboard shows which Git branch each conversation's project is on, and warns when HEAD is detached.

### Added

- The branch shows under the chat title, in the status bar and beside each project group in the sidebar, worktrees included.
- A detached HEAD shows its short commit in the warning colour, since work there belongs to no branch.

## v1.16.3 - 2026-10-08

**Dashboard keeps checking for updates after updating itself.** After an update from the dashboard's button, the dashboard checks for the next release again.

### Fixed

- Updating from the button restarted the dashboard with update checks off until the machine restarted; this is fixed from any release.

## v1.16.2 - 2026-10-08

**The Terminal says what the dashboard says.** The Terminal now offers updates, a `/bypass` switch, and the dashboard's explanations for network commands and failures.

### Breaking changes

- The company launcher changed: if `piagent studio` reports the setup changed, import it again in Agent Watch → Studio.

### Added

- `pi` and `piagent studio` offer a new Piagent between turns with “Cập nhật ngay” or “Để sau”; `/piagent-update` checks at once.
- `/bypass` in `piagent studio` switches between asking first and Bypass, and the footer shows “Bypass” while on.

### Improved

- Network command prompts, failed requests and Harness notes read in the dashboard's Vietnamese wording.

### Fixed

- A slash command of a company Terminal extension was sent to the model as a message.

Requires: Agent Watch 0.15.2 for the Keychain prompt after a Watch update.

## v1.16.1 - 2026-10-07

**New releases announced in a dialog and checked every hour.** A dialog announces each new release, checks run hourly, and a dashboard tab no longer loses its sign-in to another local Piagent server.

### Added

- A dialog shows what a new release changes with “Update now”; “Later” asks again after an hour.

### Improved

- The dashboard and the Terminal check for a new release every hour.

### Fixed

- A dashboard tab lost its sign-in when another local Piagent server signed in; each port now has its own cookie.
- A signed-out tab stops polling and says how to reopen Piagent with `piagent dashboard` or Agent Watch.

## v1.16.0 - 2026-10-07

**Bypass for company conversations.** Company conversations can run in Bypass, where network commands run without asking but anything that pushes or deletes still asks.

### Added

- In Bypass, installs, downloads, `git pull` and tests with a server or browser run without asking; Ask first stays the default.

### Improved

- Personal sessions with full access no longer ask before a broad `git add`.

### Fixed

- A helper added to the Harness during a conversation can be used from the next message.

### Security

- Bypass still asks before `git push`, deploys, uploads, migrations, unclear deletes and `sudo`, and says why.

## v1.15.2 - 2026-10-07

**Long company conversations compact again, and earlier.** Summaries of long company conversations work again and start at 90% of the model's window, never later than 300k tokens.

### Improved

- Compaction starts at 90% of the window and never later than 300k tokens, keeping about the last 20k tokens verbatim.

### Fixed

- Long company conversations could not be summarised and kept growing past the model's window; summaries now use the run's grant.
- A failed summary is retried after 1, 2, 4 … minutes (at most 30) instead of before every step.

## v1.15.1 - 2026-10-07

**Studio sees what each company model call is for.** Each company model call tells Studio its purpose, and several conversations in one folder keep their changes apart.

### Added

- Each company model call tells Studio what it is for, such as an answer, a summary or a subagent brief; no other prompt text is sent.

### Improved

- `piagent doctor` and other `piagent <command>` forms run `piagent-<command>`.

### Fixed

- Several company conversations in one folder took each other's edits; checks and review now follow each conversation's own files.
- A new company conversation whose runtime fails to open says why, and Archive and Restart work without restarting the dashboard.

Requires: Agent Studio 0.20.0 to see call purposes.

## v1.15.0 - 2026-10-07

**A refused subagent says why, long noisy commands finish.** A company subagent Studio refuses now gives Studio's reason, and long commands that print a lot are no longer stopped.

### Improved

- A company command writing to `/tmp` is told to use `$TMPDIR` or the project.

### Fixed

- Every refused subagent said the key, Harness or run had changed; it now gives Studio's actual reason.
- Commands that printed for more than about 25 seconds, such as test suites or builds, were stopped as too large; they now finish.
- `piagent-update` from `npm exec` installs a lasting helper, and on Windows Pi is found in custom npm prefixes.

Requires: Agent Watch 0.15.0; Agent Studio 0.19.0 for model fallback.

## v1.14.0 - 2026-10-06

**Updates keep each member's Pi model choices.** Updates set Pi's default model and model list only on first install, then keep yours and add only newly offered models.

### Added

- `piagent-update -- --reset-model-scope` applies Piagent's preset over your choices.
- Windows installs with one PowerShell command, and the docs site has a Windows install page with fixes for failed installs.

### Improved

- `piagent-update`, the dashboard update and `piagent-setup` keep your default model and list; a model you removed is not added back.

### Fixed

- `piagent-update` in WSL2 no longer warns that WSL2 is experimental.

## v1.13.1 - 2026-10-06

**Conversations keep their place, agent text is formatted.** Reopening a conversation no longer jumps to its first message, and text between tool calls is formatted like the final answer.

### Improved

- Updating from 1.13.0 needs no new Agent Watch import; from 1.12 or earlier, import again as for 1.13.0.

### Fixed

- Opening a conversation jumped to its first message; it now keeps its place, or opens at the newest message.
- Text between tool calls showed raw markdown; it is now formatted like the final answer.

## v1.13.0 - 2026-10-06

**Piagent on Windows through WSL2.** Company conversations run on Linux and WSL2 in a sandbox with the macOS guarantees; personal mode on Windows itself is a preview.

### Breaking changes

- After updating, each member imports the Piagent configuration again in Agent Watch, since the company launcher changed.

### Added

- The Linux sandbox keeps the project writable, other folders read-only, credentials empty and unapproved commands offline.
- Agent Watch for Windows binds Piagent in WSL, and `piagent studio --doctor` checks each sandbox guarantee.
- From WSL, the folder picker is the Windows dialog and links open in the Windows browser.

### Fixed

- Several Windows path, loader and file-saving bugs that stopped the guard, dashboard and `piagent` are fixed.

## v1.12.1 - 2026-10-06

**Forked company conversations take messages again.** A forked company conversation now accepts messages; forks made with 1.12.0 or earlier must be forked again.

### Breaking changes

- Forks made with 1.12.0 or earlier stay unreachable: fork the source conversation again after updating.

### Fixed

- Every message to a forked company conversation returned “The message was not sent”; forks now work.

## v1.12.0 - 2026-10-06

**@ any file or folder, skills with /, tests in the company sandbox.** @ picks any file or folder, agents read outside folders read-only, existing skills work with /, and common test suites run in the sandbox.

### Added

- Typing @ offers the project's files and folders, and after `~/`, `/` or `../` any folder on this Mac.
- Agents read folders you point to outside the project, read-only; hidden home files, `~/Library` and credential files stay closed.
- Skills and commands in the project's and your agent folders, such as `.pi` and `.agents/skills`, work with `/command` or `/skill:name`.
- Tests of common languages run in company conversations, with per-project package caches and local servers reachable.

### Improved

- An unsent message stays in each conversation and the new chat across switching and reloads.

### Security

- Personal conversations could edit `~/` paths outside the project; the guard now checks the path the tool actually opens.

## v1.11.1 - 2026-10-05

**Updates end on the new release's dashboard.** Whether started from the dashboard or `piagent-update`, an update now ends with the dashboard running the installed release.

### Fixed

- An update from the dashboard installed the release but could not restart the dashboard on npm installs; it now restarts.
- After `piagent-update`, `piagent dashboard` reused the old release's dashboard; it now restarts on the installed one.

## v1.11.0 - 2026-10-05

**One-click updates and an editor-style dashboard.** The dashboard checks for and installs Piagent and Pi updates itself, and gains a status bar, a command palette and searchable Settings.

### Added

- The dashboard checks for a new release on open and every 6 hours, and shows it in the status bar and Settings.
- One click updates Pi and Piagent together, with Pi kept on the version Piagent pins; it is locked while a turn runs.
- A command palette (⌘K / Ctrl+K) reaches actions, settings and conversations by name, ignoring Vietnamese accents.
- Settings can be searched by what a setting does, with grouped sections and a Shortcuts section.

## v1.10.0 - 2026-10-05

**Agent asks when unclear, subagents can object to a brief.** The main agent asks you numbered questions when a decision is open, and subagents can object to a brief with evidence.

### Added

- The main agent asks 1–4 questions with numbered options and “Other” when the request leaves a decision open, then waits.
- Subagents read your request verbatim and can object to a brief with evidence; a second objection goes to you.

### Improved

- A subagent out of quota or whose account is resting runs again on the Harness's fallback model.
- A patch larger than 120 KB is reviewed in parts and the findings merge, instead of stopping the review.

### Fixed

- A check that returns an error result now counts as failed, so a required check never passes on a failing run.

## v1.9.3 - 2026-10-03

**Vietnamese typing no longer sends twice, helpers read less.** Enter used by an input method no longer sends, a double Enter sends once, and helpers read less of each web page.

### Improved

- A helper reads at most 20,000 characters of a web page (12,000 by default), cutting token use on research.

### Fixed

- An Enter that commits text from a Vietnamese input method sent the message; it now only finishes the word.
- Pressing Enter twice could create two identical conversations; it now creates one and sends one message.

## v1.9.2 - 2026-10-03

**Web work goes to the research helper, chat stays in place.** With a research helper, web work runs on its model and only a summary reaches the main agent; sending no longer jumps the page.

### Improved

- With a research helper in the Harness, searches and page reads run on its model and only its summary with sources returns.
- Each search result names the engine that answered it.

### Fixed

- Sending a message in a long company conversation jumped the page to the top; the history now stays in place.
- The helper count shows the number the Harness enables instead of a fixed 2.

## v1.9.1 - 2026-10-03

**Scout and verify helpers, web search for every company role.** Two more company helpers, web search for every role through the team's search pool, and type checks and end-to-end tests in the sandbox.

### Added

- Scout reads the project only and answers with `file:line` facts; verify runs checks offline and rates each claim with evidence.
- Company `web_search` uses the team's search pool for every role, so roles on API-key models can search too.

### Improved

- A command's own timeout, up to 30 minutes, now extends the 10-minute limit.

### Fixed

- Type checks, test runners and end-to-end suites that the sandbox used to stop now run, with credential files hidden.
- `piagent-install` and `piagent-setup` no longer suggest commands that 1.9.0 retired, which would have started a paid turn.

## v1.9.0 - 2026-10-02

**Freeform sessions and the team Harness.** The task contract and workflow commands are gone: you ask in plain language, the guard checks every tool call, and company mode runs the team's Harness.

### Breaking changes

- Retired the task contract and `/workflow`, `/fresh`, `/onboard` and related commands; ask in plain language instead.

### Added

- Company sessions run the team's Harness from Studio: plan, checks and review each turn, suggested or required, with bounded fix loops.

### Improved

- When every company model account is busy, a request waits in line for up to 20 minutes instead of failing.

### Fixed

- Approved network commands always failed with `ENOTFOUND`; `run_with_network` now resolves host names.
- The dashboard was slow with many conversations and left messages sent after Stop unconfirmed; both are fixed.

### Security

- Agent Studio credentials are now redacted in edit previews, command output and the gateway stream.

Requires: Pi 0.87.1.

## v1.8.0 - 2026-09-23

**GPT-6 Astra, Sol and Luna models.** Pins Pi to 0.87.1 so authenticated sessions and the WebUI can list GPT-6 Astra, Sol and Luna, and adds a GPT-6 routing map.

### Added

- GPT-6 Astra, Sol and Luna appear in authenticated sessions and the WebUI; Pi's catalog decides availability.
- New parent-routing map: Luna Medium for bounded work, Sol Medium/High for everyday work, Astra Extra High for broad work.

### Improved

- Parent routing stays off by default and explicit model pins are unchanged.
- New setup and WebUI sessions prefer GPT-6 Sol High; existing sessions and explicit settings are not rewritten.
- If a GPT-6 target is unavailable, the router records a 5.6 fallback instead of substituting it silently.

Requires: Pi 0.87.1.

## v1.7.1 - 2026-09-23

**Pi 0.86.1, requested pauses and diagnostic acceptance.** Replaces the unpublished v1.7.0, updates Pi to 0.86.1, adds a wait tool for requested pauses and makes acceptance proof diagnostic by default.

### Added

- Added a wait tool for pauses you request inside a session; it does not call the model while waiting.

### Improved

- Updated Pi to 0.86.1, keeping the selected model and thinking level while correcting usage and WebUI settlement.
- Acceptance proof is diagnostic by default: unproved criteria stay pending; strict mode remains available by policy.
- Task usage, timing and context delivery are bound to the active task, and unsupported context files are filtered out.
- The release CI limit is raised to 75 minutes after the v1.7.0 macOS gate timed out.

Requires: Pi 0.86.1.

## v1.7.0 - not published

**Not published; use v1.7.1.** The tag exists, but its macOS gate timed out twice at 40 minutes, so no npm package or GitHub Release was created.

### Improved

- No `@piagent/platform@1.7.0` package exists; install v1.7.1 instead.

## v1.6.1 - 2026-08-26

**Truthful WebUI state and read-only source review.** The WebUI no longer shows success before a task ends, Git host links can be reviewed read-only, and subagent use is capped at one helper.

### Added

- A GitHub or other Git host link can be checked out for read-only review, up to eight sources, cleaned up at session end.

### Improved

- Subagents are limited to one read-only helper with bounded calls, turns and runtime, and no automatic retry.

### Fixed

- A pending task could show a completed message or success bubble; drafts now stay hidden until the task ends.
- Rejected or evidence-free helper calls could later show as passed in Activity; they now stay visible as failures.
- Attachments and workflow wrappers no longer replace your actual request when a task starts.

## v1.6.0 - 2026-08-24

**Leaner context, redacted snapshots, steadier WebUI.** One criterion-aware context pack replaces overlapping discovery, source snapshots are redacted before reaching the model, and the WebUI recovers after reloads.

### Improved

- One criterion-aware initial context pack replaces overlapping discovery and puts explicit targets and their tests first.
- New installations default to GPT-5.6 Sol with High thinking; you can still pick another model per message or session.
- Reloads and multiple browser tabs agree on the running operation, and concurrent Stop requests share one termination.
- A token-reduction claim is published only after a complete zero-retry 108-session run on the exact tagged release.

### Fixed

- Empty provider output could create a blank success bubble in the conversation; it no longer does.

### Security

- Automatic source snapshots are redacted before reaching the provider, including short and numeric secret values.

## v1.5.5 - 2026-08-21

**WebUI command execution hotfix.** Fixes approvals that fell back to a missing terminal prompt, search commands mistaken for migrations, and sessions stuck after Stop.

### Fixed

- Some tool calls fell back to a terminal confirmation that does not exist in the WebUI; they are now approved in the WebUI.
- `rg` and `grep` with `migrate` in their arguments were treated as migrations; real migrations still need confirmation.
- Stop could leave a session waiting on an approval; it now cancels the pending approval first.
- Dashboard restart could silently reuse a hung instance; it now waits for the old process to exit.

## v1.5.4 - 2026-08-20

**WebUI workflow hotfix.** New WebUI sessions no longer report an unknown command effect after the turn started, and completed turns no longer appear twice.

### Improved

- While sync is still in progress, the UI opens the known session and blocks a resend that could run the request twice.

### Fixed

- New WebUI sessions reported an unknown command effect although Pi had started the turn; this is fixed.
- Completed turns appeared twice in the transcript; they now appear once.
- A slow model-catalog refresh could undo a model or thinking change you just made and leave the button disabled.

## v1.5.3 - 2026-08-20

**WebUI and Terminal parity.** The Session Hub gains ten per-message workflows, a simpler new-session composer and Project Controls, plus a new deep-logic benchmark.

### Added

- The Session Hub offers ten per-message workflows; after sending, the composer returns to Freeform.
- Project Controls cover runtime, usage, onboarding, Context Engine, memory and MCP; changes ask for confirmation.
- Added the `deep-logic-v1` benchmark: six large problems, run with Piagent and `codex-cli` on GPT-5.6 Luna Medium.

### Improved

- The new-session composer shows project, model and send; advanced choices sit behind a `+` control.
- `capability-v1` grows from four to six families with 69 atomic checks.

## v1.5.2 - 2026-08-18

**Drag and drop in the new-chat composer.** A document dragged or pasted onto the new-chat composer is now attached instead of being silently lost.

### Fixed

- A document dropped or pasted on the new-chat screen was silently lost; it is now attached.
- A file dropped outside the composer no longer navigates the page away.

## v1.5.1 - 2026-08-17

**Release repair for v1.5.0.** Publishes the content of v1.5.0, which was tagged but never published, plus a fix for a composer test race.

### Improved

- Ships everything from v1.5.0, whose macOS release matrix failed before publishing.

### Fixed

- Fixed a WebUI composer test race that left the confirm button disabled on slower runners.

## v1.5.0 - 2026-08-17 (not published)

**Document workspace and attachments.** Adds a document workspace, attachments and a compact activity timeline to the Session Hub; tagged but not published, shipped as v1.5.1.

### Added

- A document workspace in the Session Hub for Markdown, text, PDF and DOCX, with redaction and in-browser previews.
- Attach documents and images in New chat and in active sessions; sent files show as compact cards.
- Session titles and previews are generated without a model turn.

### Improved

- Large tool-result blocks in chat are replaced by a compact live activity timeline.
- Project folder import is more reliable on macOS and Linux, including several folders at once.
- Providers & models shows whether each model supports web search and image input.

## v1.4.1 - 2026-08-17

**Integrity, redaction and install fixes.** Closes gaps in the runtime integrity lock, redacts npm tokens, fixes install and uninstall bugs, and lets the dashboard start without the MCP adapter.

### Added

- Added Google Drive, Gmail, Docs and Sheets MCP servers as experimental, kept out of every default preset.

### Fixed

- The two-command install could downgrade the global Pi package to a project's pin; the two scopes now resolve separately.
- Uninstall did nothing under a non-default npm prefix yet reported success; it now uses the helper's actual prefix.
- `piagent dashboard` failed to start when the MCP adapter was not installed; it now starts.

### Security

- The integrity lock now covers shell entrypoints and the served WebUI bundle, which could previously run unpinned code.
- npm tokens in `.npmrc` lines and in publish output are now redacted.

## v1.4.0 - 2026-08-15

**Local Session Hub and WebUI.** Adds `piagent dashboard`: a local Gateway and browser client to create, resume and review Pi sessions without extra model turns.

### Added

- `piagent dashboard` opens a local Gateway to create, reopen, resume, rename, pin, archive and fork sessions.
- A conversation-first browser client with light and dark themes, Vietnamese and English UI, and an Agent Inspector.
- Streaming chat, held-message queues, attachments, model and thinking controls, and approval cards in the browser.
- Task Changes, Working Tree and Staged views with bounded diffs and guarded stage, unstage and revert actions.

### Improved

- Sessions recover after restarts and stale owners, and corrupt state fails closed.

### Security

- Hardened the TypeScript loader, local control socket, browser authentication, redaction and credential handling.

## v1.3.1 - 2026-08-13

**Security and reliability hardening.** Widens the integrity inventory, speeds up per-call integrity checks with a cache, and lets local state locks recover safely.

### Improved

- Integrity checks use a metadata cache instead of rehashing files on every tool call; build drift mid-session blocks until restart.

### Fixed

- A hard-killed writer no longer leaves a state lock stuck; if recovery itself is killed, remove its `.recovery` lock.

### Security

- The integrity inventory now covers the TypeScript loader, the CLI dispatcher and the remaining enforcement modules.
- Removed shell interpolation from the PDF tool availability check.

## v1.3.0 - 2026-08-12

**First stable intelligence engine release.** Promotes the ie.9 tree to stable with Pi 0.84.1 and unchanged runtime behaviour; stable installs come from npm `latest`.

### Added

- First stable package with Pi 0.84.1, where every terminal command works from the installed package.

### Improved

- Stable installs use npm `latest` and the Git tag `v1.3.0`; the prerelease `next` channel is now historical.
- Runtime behaviour is unchanged from ie.9, with conservative defaults: parent routing off, recovery on, one continuation.
- The 108-session Luna Medium run from ie.7 is kept as evidence and not relabelled as a v1.3.0 measurement.

Requires: Pi 0.84.1.

## v1.3.0-ie.9 - 2026-08-12

**Installed-package runtime parity.** Commands installed from npm can now load the TypeScript runtime, fixing the route and benchmark commands that failed in ie.8.

### Improved

- The global benchmark helper uses the exact Pi package source installed by `piagent-install --stable`.
- A packed-and-installed test now checks that every global command prints its help.

### Fixed

- In ie.8 the route and benchmark commands could not load TypeScript from `node_modules`; they now work.

## v1.3.0-ie.8 - 2026-08-12

**Reproducible prerelease publishing.** Fixes the publish job that stopped ie.7 before publishing; the runtime is identical to ie.7.

### Improved

- The runtime is unchanged from ie.7; this release corrects distribution only.

### Fixed

- The tag-driven publish job now fetches the full tag history and installs the test prerequisites it needs.

## v1.3.0-ie.7 - 2026-08-12 (not published)

**Return-shape guidance before the first edit.** The first model turn now shows whether a public result returns names or objects, so edits keep the public API intact.

### Improved

- Detects whether helper results return names or objects, including graph traversals, and shows it before the first edit.
- No hard gate, extra continuation or benchmark change is added.

## v1.3.0-ie.6 - 2026-08-12

**Benchmark stop aligned with the evaluator.** The paired benchmark stops only when a Piagent outcome falls below the floor; a miss by the baseline alone no longer ends coverage.

### Improved

- A Piagent outcome below the frozen floor stops the run after its pair; a baseline-only miss does not.
- Helper timing under parallel load is observational; correctness, token reduction and privacy gate the release.

## v1.3.0-ie.5 - 2026-08-12

**Finite release benchmark and `next` publishing.** Benchmark runs stop after a below-floor pair, and prerelease packages publish to npm `next`, keeping `latest` for stable releases.

### Added

- A release benchmark stops after the current pair once an outcome falls below the floor, starting no new paid session.

### Improved

- Prereleases publish to the npm `next` dist-tag; `latest` stays reserved for stable releases.

## v1.3.0-ie.4 - 2026-08-11

**Matching CI prerequisites on Ubuntu and macOS.** CI installs the same search tool on Ubuntu and macOS and gives integration waits more room; no product gate was relaxed.

### Improved

- CI installs the same test prerequisite on Ubuntu and macOS, and integration test deadlines allow for filesystem load.

## v1.3.0-ie.3 - 2026-08-11

**Deterministic cross-platform helper gate.** The release gate now depends on helper correctness and token reduction, not on timing that varied on Linux CI.

### Improved

- Helper timing stays as a metric, but the release gate checks retrieval correctness, token reduction and privacy.

## v1.3.0-ie.2 - 2026-08-11

**Pi 0.84.1 host pin.** Raises the Pi host pin to 0.84.1, which passes the dependency audit and replaces an expired advisory exception.

### Improved

- Pi Coding Agent and Pi AI are pinned to 0.84.1, with host compatibility and package lifecycle checked again.

### Security

- The new host tree audits clean at moderate and above, so the expired 0.82.0 advisory exception is removed.

Requires: Pi 0.84.1.

## v1.3.0-ie.1 - 2026-08-11

**Intelligence engine candidate.** Adds a Criterion Graph and bounded current-source context so Luna Medium can plan against your criteria without an extra model turn.

### Added

- A Criterion Graph and bounded current-source context let the model plan against your criteria without a repository index.

### Improved

- Advanced capabilities ship but stay off or advisory by default; verification and permissions are unchanged.
- rc.1 and rc.2 remain historical evidence; the ie line uses its own prerelease identity.

## v1.3.0-rc.2 - 2026-08-11

**Criterion coverage before the first verifier.** Before the first verifier, the agent maps each criterion to implementation and tests, batches independent steps and reviews once.

### Improved

- The agent maps every criterion to code and focused tests, batches independent steps and reviews once before verifying.

### Fixed

- A test-only file is no longer shipped in the package, and valid empty JavaScript files pass the source check.

## v1.3.0-rc.1 - 2026-08-11

**Routing, inspector, recovery and helpers.** Adds prelaunch model routing with `piagent-route`, a `/piagent-inspector` view, richer `/piagent-status`, bounded recovery and role-bound helpers.

### Added

- `piagent-route` picks a model by capability band before launch; it never switches models mid-conversation.
- `/piagent-inspector` adds a status line and views for diffs, tests, tool outcomes, warnings and context budget.
- Failures are classified with at most one source repair or retry; `PIAGENT_AUTO_RECOVERY=off` keeps the old handoff.
- Role-bound helpers with budgets and a single writer; `PIAGENT_HELPERS_MODE` defaults to `recommend`.

### Improved

- `/piagent-status` shows task, checkpoint, verifier, recovery, helper and resume evidence.

### Fixed

- Fixed long-prompt intake, scope resolution and verifier defaults; read-only tasks stay free of edits.

## v1.2.17 - 2026-08-03

**English documentation for every public page.** All 17 documentation pages now have an English version under `/en`, with VI/EN switching and Vietnamese URLs unchanged.

### Added

- Added an English version of all 17 public documentation pages under `/en`.
- Each page links to the same topic in the other language, with localized navigation.

### Fixed

- On mobile the docs kept desktop sidebar columns; the layout is now a single column again.

## v1.2.16 - 2026-08-03

**GPT-5.5 with high thinking becomes the default.** Setup, global install and the settings template now default to `openai-codex/gpt-5.5:high`; explicit `xhigh` still works.

### Improved

- The default model is now `openai-codex/gpt-5.5:high` across setup, global install and model scope.
- A model without a thinking suffix now falls back to `high`; explicit `xhigh` selections are kept.

## v1.2.15 - 2026-08-03

**Stable updates work from local-path installs.** Updating a machine whose Piagent was registered from a local path no longer fails when started outside the Pi agent directory.

### Fixed

- Stable updates failed on machines with a local-path Piagent registration; the installer now removes it by absolute path.

## v1.2.14 - 2026-08-03

**Runtime split into modules and native `/name` restored.** The guard is split into focused, integrity-locked modules, and Piagent no longer hides Pi's own `/name` command.

### Improved

- Session, input, context and task intake logic moved out of the guard into modules, with behavior unchanged.

### Fixed

- Piagent registered its own `/name` and shadowed Pi's command; Pi's `/name` works again and `/setname` stays as an alias.
- Legacy task migration keeps long task ids unique and can no longer delete a newly written contract on macOS.

### Security

- Capability integrity locks now pin every extracted runtime module.

## v1.2.13 - 2026-08-03

**Dedicated benchmark page.** A static benchmark page shows the verified production-v1 scores, token usage and paired comparison with simple charts.

### Added

- Published a benchmark page with production-v1 scores, median usage, paired token comparison and confidence interval.

### Improved

- Charts are plain CSS with no charting library or data fetch, and read well on desktop and mobile.
- The claim is scoped to the controlled public suite, not presented as a universal result.

## v1.2.12 - 2026-08-03

**Production benchmark with 108 sessions.** A 108-session benchmark across 18 scenario families measured Piagent at 9.92 overall and about 51% fewer fresh tokens than `codex-cli`.

### Added

- Added `production-v1`: 108 sessions over 18 scenario families, three task sizes, five profiles and hidden oracles.
- Added a controlled comparison against `codex-cli` on the same model and thinking, isolated per session.

### Improved

- Piagent scored 9.92 overall with a paired fresh-token estimate 51.11% lower (95% ratio 0.3809 to 0.6276).
- Recovery guidance now lists only verifier commands still missing passing evidence, each as a separate shell call.

## v1.2.11 - 2026-08-02

**Task harness v2: one session per task, evidence-gated completion.** Tasks bind to one Pi session, completion requires passing verify evidence, and routine tasks start with no management round trips.

### Added

- Each task is bound to one Pi session; a retry starts a fresh session and inherits prior failure evidence.
- Completion requires every verify command to pass after task start, and changed files are checked against Git and scope.
- Added `piagent-benchmark`, a one-command paired comparison of raw Pi, Piagent or `codex-cli` with private reports.

### Improved

- Runtime creates bounded task contracts before the first model turn, so routine tasks need no setup tool calls.
- One automatic follow-up runs when an agent stops with missing evidence; set `PIAGENT_AUTO_RECOVERY=off` to disable.

### Fixed

- `piagent-update` could install a second copy under another npm prefix; it now stays in the prefix that owns the command.

## v1.2.10 - 2026-07-31

**Context index hardening and read-only reviewer.** The context index is owner-only and purges deleted source, image auto-attach is scoped, and `piagent-reviewer` is now truly read-only.

### Security

- Context index files are owner-only and securely delete removed source; older indexes migrate once to purge leftovers.
- Images named in chat are auto-attached only from allowed, non-protected project paths and must be real images.
- `piagent-reviewer` now has only read tools; autofix moves to `piagent-worker`.
- MCP approval and `piagent-mcp doctor` now detect `directTools` set on individual servers.

## v1.2.9 - 2026-07-31

**Context Engine follows the same policy as the guard.** Context search and packs now use the guard's exclusion rules, so protected content never reaches the model through old indexes.

### Fixed

- `piagent-update --dry-run --project` showed a stack trace when the project migrator was missing; it now says so directly.

### Security

- Context Engine and runtime share one policy for protected, read-only and excluded paths.
- Indexes built under weaker rules are rebuilt automatically and filtered again at read time.
- Symlinks and paths leading outside the project are refused when building and reading the index.

## v1.2.8 - 2026-07-31

**Web research for researcher subagents by default.** Setup and update now install the web access add-on so researcher subagents can search and fetch external sources.

### Added

- Global setup and update install `pi-web-access@0.17.0` by default; opt out with `--no-web-access`.

### Fixed

- Older web access registrations kept stale dependencies; install now removes them before installing the reviewed version.

## v1.2.7 - 2026-07-31

**Patched MCP and subagent add-ons.** The pinned MCP and subagent add-ons move to versions whose dependency tree reports no advisories, and the audit gate is stricter.

### Improved

- An existing `pi-subagents` install is upgraded during a normal platform update.

### Fixed

- Updates could keep a vulnerable transitive version; old add-on registrations are now removed before reinstalling.

### Security

- Updated to `pi-mcp-adapter@2.15.0` and `pi-subagents@0.38.0`, which resolve patched dependencies.
- The release gate now also blocks moderate advisories; one documented dependency advisory in the Pi host remains accepted.

## v1.2.6 - 2026-07-31

**Context Engine v2 and task-shaped tool loading.** A local code index builds bounded context packs, and Piagent exposes only the tools a task needs while guards stay active.

### Added

- Added Context Engine v2: a local incremental code index with budgeted context packs and the `piagent-context` command.
- Added Agent Watch compatible context telemetry by session, without storing raw prompts or tool output.

### Improved

- Tools load by task shape: tiny tasks see 11 of 30 Piagent tools, ordinary tasks 15; guards apply regardless.

### Fixed

- A local checkout and the released package could load together; install now removes older local registrations.

## v1.2.5 - 2026-07-30

**`piagent-update` works with npm 12.** The updater now reads npm 12's registry output when resolving the target version and its Pi host.

### Fixed

- `piagent-update` failed to read npm 12 version metadata; it now accepts it and still refuses ambiguous results.

## v1.2.4 - 2026-07-30

**Smoother team rollout for `piagent-update`.** Updates fall back to a user-writable npm prefix, and `--project` adds an optional migration and doctor check.

### Improved

- Optional `--project <path>` runs a legacy project migration and doctor after the global update.
- Documented an `npm exec` bootstrap command for machines without the global `piagent-update` helper.

### Fixed

- Updates failed with permission errors when the npm prefix was OS-locked; they now use a user-writable prefix.

## v1.2.3 - 2026-07-30

**Short runtime commands.** Short commands such as `/usage`, `/context` and `/permission` were added, and workflows moved under `/workflow` and `/fresh`.

### Added

- Added `/commands`, `/usage`, `/context`, `/permission`, `/memory`, `/onboard`, `/name` and `/fresh`.

### Improved

- Workflow launchers are grouped under `/workflow`, and `/piagent-workflow` still routes there.
- Docs now separate Pi native commands such as `/model` and `/resume` from Piagent commands.

## v1.2.2 - 2026-07-29

**Compact output for large tool results.** Oversized tool output shows a bounded preview and is saved locally, and `/setname` renames an open session.

### Added

- Large tool results show a bounded preview and are saved under `.pi/piagent-state/tool-results/`.
- Added `/piagent-logs` to see recent oversized output captures without calling the model.
- Added `/setname` to rename an open session for resume lists, Agent Watch and reports.

### Improved

- `/piagent-usage` and `/task-preflight` now print short status lines.

## v1.2.1 - 2026-07-28

**MCP approval gate and shell guard fixes.** The MCP approval gate now covers direct tools and imported servers, and the shell guard reads commands the way the shell expands them.

### Fixed

- `piagent-mcp doctor` and `list` reported no servers while every tool call was blocked; they now name the cause and exit 1.
- A failed `piagent-capability vendor` could delete files outside the project or leave none; it now changes nothing on failure.

### Security

- MCP approval never applied to direct MCP tools; every server is now gated whatever tool naming mode it uses.
- Servers pulled in through a repository's `imports` setting are now listed and require approval.
- The shell guard now resolves braces, quoting, `printf` and substitutions before checking protected paths and deletes.
- `piagent-mcp add` refuses credentials in server URLs, and `list` and `get` mask them.

## v1.2.0 - 2026-07-28

**MCP server management with repository approval.** `piagent-mcp` now manages servers, and servers defined by a repository need local approval before use.

### Added

- `piagent-mcp` gains `add`, `remove`, `get`, `list`, `enable`, `disable` and `doctor` across config layers.
- `/piagent-mcp` opens an in-session menu for status, approval and diagnostics without a model turn.

### Improved

- The docs site is split into one page per topic, with four pages for MCP.

### Security

- Servers defined in a repository need `piagent-mcp approve` on this machine; changing their command resets approval.
- `piagent-mcp add` refuses to write credentials into MCP config and shows the reference form to use.

## v1.1.9 - 2026-07-28

**Update notice reaches ordinary installs.** The update notice from 1.1.8 was hidden on installs cloned by Pi; it now appears for every non-development install.

### Fixed

- Installs from Git were mistaken for working copies and got no update notice; they now see it.

## v1.1.8 - 2026-07-28

**Pi tells you when a release is available.** The session-start line now shows when a newer Piagent is out and names `piagent-update` as the command to run.

### Added

- The session-start line shows an update notice naming `piagent-update` when a new release exists.

### Improved

- The check reads a cache refreshed in the background at most daily, so sessions do not wait on it.

## v1.1.7 - 2026-07-28

**Projects keep working after a platform update.** Capability locks behind the installed platform are re-pinned instead of blocking the session, and policy fixes reach every project.

### Added

- A project profile can `extends` an adapter instead of copying its policy.

### Improved

- Policy, prompt and skill content now follows the installed platform, so corrections reach existing projects.

### Fixed

- Projects with capability packs stopped working after each release until reapplied; the lock is now re-pinned automatically.

## v1.1.6 - 2026-07-27

**Monorepo detection and scoping fixes.** Profiles now detect and scope frontend and backend packages correctly in monorepos and workspaces.

### Fixed

- `be-readonly-fe` left nested backends writable in monorepos; they are now read-only.
- Frontend verify ran nothing and reported success when the frontend sat elsewhere; it now finds the right package.
- Packages declared in `workspaces` or `pnpm-workspace.yaml` were ignored; detection now reads them.

## v1.1.5 - 2026-07-27

**One-command update with `piagent-update`.** `piagent-update` moves the Pi host, helper and Pi package to the next release in the correct order.

### Added

- Added `piagent-update`, which updates the Pi host, terminal helper and Pi package in order.
- `--check` and `--dry-run` show exactly what a real run would install, resolved before anything changes.

## v1.1.4 - 2026-07-27

**Redaction of credentials in command options.** Credentials passed as command-line options or `Authorization` headers are now redacted reliably.

### Security

- Options such as `--token`, `--password` and `--api-key` were not redacted; their values are now hidden.
- `Authorization` header values are redacted wherever they appear in the arguments.

## v1.1.3 - 2026-07-27

**Fixes for issues found reviewing 1.1.2.** Short secrets are redacted, verify evidence identifies commands exactly again, and document reads no longer hang on pipes.

### Fixed

- Verify evidence gave commands with different secrets the same identity; each command is identified exactly again.
- Reading a document replaced by a named pipe hung; it is now refused.
- `piagent-install` showed `node: command not found` without Node.js; it now reports the missing runtime clearly.

### Security

- Short secret values such as `TOKEN=hunter2` were stored in clear text; they are now redacted.

## v1.1.2 - 2026-07-26

**Security and release gating fixes.** Document reads close a file-swap race, evidence no longer hashes unredacted commands, and publishing waits for all checks.

### Improved

- Publishing now waits for the full verification matrix to pass.

### Fixed

- An unknown `--mcp-preset` failed only after a partial install; it is now rejected before anything is installed.

### Security

- `piagent_document_read` could read a file swapped in after its checks; it now reads the file it checked.
- The evidence ledger no longer stores a hash that could confirm guesses at a redacted secret.

## v1.1.1 - 2026-07-26

**Fixes for issues found reviewing 1.1.0.** `piagent-setup --no-mcp` skips MCP again, the site check no longer hangs or passes falsely, and binary documents are refused.

### Fixed

- `piagent-setup --no-mcp` still installed MCP; it installs none again.
- `npm run site:check` could hang on large responses or pass with unchecked addresses; both are fixed.
- `piagent_document_read` decoded binary bytes into garbled text; it now refuses invalid text.

## v1.1.0 - 2026-07-26

**Read documents from outside the project.** The agent can read a downloaded document outside the repository, and both install commands now install MCP by default.

### Added

- Added `piagent_document_read` to read a document from a granted directory outside the project, including `.docx`.

### Improved

- `piagent-install` now installs the MCP baseline by default like `piagent-setup`; both accept `--no-mcp`.
- The pinned Pi host moves from 0.81.1 to 0.82.0.

### Fixed

- Advisory tool-registry warnings were computed but never shown; they are now displayed.

Requires: Pi 0.82.0.

## v1.0.2 - 2026-07-25

**Two-command install and `piagent-uninstall`.** Install is now `npm install -g @piagent/platform` plus `piagent-setup`, and `piagent-uninstall` removes the package cleanly.

### Added

- Added `piagent-uninstall`, which reports by default and only removes the package with `--apply`.

### Improved

- Docs now lead with `npm install -g @piagent/platform` followed by `piagent-setup`.

### Fixed

- `piagent-setup` wrote a local install path into project settings; it now writes the npm package version.

## v1.0.1 - 2026-07-25

**Install from the npm registry.** Documentation now installs the terminal helper from npm instead of the Git source.

### Added

- Added an `npm` release channel.

### Improved

- Install, update and rollback docs use `npm install -g --ignore-scripts @piagent/platform@1.0.1`.

## v1.0.0 - 2026-07-25

**Piagent 1.0: new namespace and stable API.** The `company` namespace becomes `piagent` with no alias, `apiVersion` is stable, and one command migrates existing projects.

### Breaking changes

- Tools, commands, package and files are renamed from `company` to `piagent`; run `piagent-migrate` on existing projects.
- Manifest `apiVersion` moves from `piagent/v1alpha1` to the stable `piagent/v1`.

### Added

- Projects can use capability packs from other sources, fetched for review with `piagent-capabilities vendor`.
- Added `piagent-import-instructions` to import instruction files written for other agents into `AGENTS.md`.

### Improved

- The package is now published on npm as `@piagent/platform` with provenance.

## v0.4.8 - 2026-07-22

**Release channels, trusted profiles and stricter guards.** Install channels and rollback are documented, project profiles load only in trusted projects, and external writes need confirmation.

### Added

- Added stable, exact, dev and local install channels with dry-run preview, plus rollback docs.

### Improved

- Requires Node.js 22.19.0 or newer and Pi 0.81.1; setup installs the exact Pi host.

### Security

- Project profiles are ignored until the project is trusted, and applying a profile needs confirmation.
- External provider writes and unknown MCP actions now require human confirmation, even in full access.

Requires: Pi 0.81.1, Node.js 22.19.0.

## v0.4.7 - 2026-07-22

**Guarded `/commit` and `/pr` workflows.** New `/commit` and `/pr` workflows review changes before staging and ask before any push, and broad staging needs confirmation.

### Added

- Added `/commit`, which stages only reviewed files, runs checks and never pushes.
- Added `/pr`, which requires a clean branch and confirmation before `git push` or GitHub writes.

### Security

- Broad staging such as `git add .` or `git add -A` now asks for confirmation.

## v0.4.6 - 2026-07-22

**Documentation site.** A static HTML documentation site was added, with shorter command docs for daily use.

### Added

- Added a static HTML documentation site under `docs-site/`.

### Improved

- Command documentation is shorter for lower-token daily use.
- Global install and pinned project setup are documented separately.

## v0.4.5 - 2026-07-22

**Direct `/profile` commands.** Profile commands apply immediately without a model follow-up, and routine status output is compact.

### Added

- Added `/profile`, `/profile list`, `/profile <profile>` and `/profile auto`, applied without a model turn.
- Added short profile aliases such as `fe`, `be` and `full`.

### Improved

- `/company-status` and `/company-memory` now return short local summaries.

## v0.4.4 - 2026-07-21

**Session permission commands.** Slash commands switch the session between read-only, workspace-write and full access, with a clear precedence order.

### Added

- Added `/permission-status`, `/read-only`, `/workspace-write`, `/full-access` and `/full-access <task>`.

### Improved

- Permission order is explicit: launch override, then session command, then project profile, then default.

### Security

- Full access still keeps protected paths, secret redaction and destructive or external confirmations.

## v0.4.3 - 2026-07-21

**Runtime permission profiles.** Three permission profiles were added: read-only, workspace-write and trusted-full-access.

### Added

- Added `read-only`, `workspace-write` and `trusted-full-access` permission profiles.
- Added `PI_COMPANY_PERMISSION_PROFILE` for a one-run override; invalid values fail closed.

## v0.4.2 - 2026-07-21

**Better secret redaction with a benchmark.** Redaction covers more credential shapes and nested data, measured by a new benchmark and release gate.

### Added

- Added a redaction benchmark: 52/52 secrets detected with 0/30 false positives on benign text.

### Improved

- Redaction now catches more credential shapes and secrets inside nested structured data.

## v0.4.1 - 2026-07-21

**Stronger shell protection for secrets.** The shell guard blocks more ways of reaching protected files, and bash output is redacted before the model sees it.

### Security

- Globs, aliases, symlinks and redirections such as `cat<.env` can no longer reach protected files.
- Sensitive bash output is redacted before tool results reach the model.

## v0.4.0 - 2026-07-21

**Governed capability packs with integrity lock.** Capability packs are resolved per profile into `.pi/company-profile.lock.json`, and tampering with the lock fails closed.

### Added

- Added governed capability packs resolved per profile into `.pi/company-profile.lock.json`.

### Security

- The lock checks package source, artifact digests and capability scope, and tampering fails closed.
- `.pi/settings.json` and the lock file are protected, and capability scope can only narrow access.
