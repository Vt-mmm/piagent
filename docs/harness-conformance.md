# Company Harness conformance
<!-- language: en -->

What "Piagent runs the company Harness" means, setting by setting. For each setting of a team's Harness in Agent Studio (`agent-studio/internal/runs/profile.go`, `Configuration`), this page names who enforces it, what a company session does, and the tests that prove it.

`tests/managed-harness-conformance.test.mjs` reads this page. It fails when a setting below has no section, when a section names a Piagent test that does not exist, or when the pinned Pi host is missing where it must be present (macOS in CI, or `PIAGENT_REQUIRE_PI_SDK=1`). Most tests listed here drive a real Pi SDK session against a scripted local Studio. Without the host they skip, and a green suite then proves nothing about the Harness. `tests/helpers/pi-sdk.mjs` finds the host through `PI_MANAGED_TEST_SDK`, the installer's prefix or the npm global root.

Studio tests are named for traceability only; run them in `agent-studio` with `go test ./internal/...`.

## Who enforces what

- **Studio** owns authority. It chooses each role's model, fixes the effort a role runs at, counts helper calls and active helpers, admits fast mode and records the process report.
- **Piagent** owns the session. It runs the model and effort its grant names, offers only the helpers the Harness enables, gives helpers read-only tools, and enforces the workflow before a code-changing turn ends.

A section's settings are named as in the Harness JSON.

## Settings

### `main.mode`

`fixed` names one model; `auto` is an ordered failover list. Studio picks the first model that serves now when the run starts; Piagent installs the model the grant names and refuses a grant for another role or model.

- Studio: `TestPickRouteOrderQuotaAndFallback`
- Piagent: `managed-session` › isolated SDK session sends native Claude/Codex streams with role tokens and native context
- Piagent: `managed-failures` › a harness changed to a model the conversation did not know: it enrolls again and runs on it

### `main.model_ids`

Only models the Harness lists, and only those every connector can run without its own fallback, are offered.

- Studio: `TestHarnessSelectionLeavesOutModelsNoHarnessCanRun`
- Studio: `TestHarnessEligibilityOfTheCurrentCatalog`
- Piagent: `managed-failures` › Studio's reason for a refused run or subagent reaches the member, not just "configuration changed"

### `main.effort`

Unset follows the member's thinking level; a value fixes it (`off` turns thinking off). The member's level is what the run asks for; the level Studio grants is what the request carries.

- Studio: `TestManagedNativeEffortHistory`
- Piagent: `managed-failures` › each role runs at the level Studio grants it, whatever the member picked

### `scout`, `research`, `verify`, `review`

A helper exists only when the Harness enables its role. The prompt and the `delegate` tool describe only enabled helpers. Helpers read the project and cannot change files or delegate. In one conversation one helper of each role runs at a time, and each role runs at most 8 times per member message (Studio's `MaxHelperCalls`). Studio also bounds a member's active helpers across conversations (`MaxActiveHelpers`, 24).

- Studio: `TestScoutAndVerifyRunAsHelpers`
- Studio: `TestManagedHelpersAggregateAcrossDevicesAndRoots`
- Studio: `TestHelperRoleRunsAgainWithinItsRun`
- Piagent: `managed-failures` › a subagent that fails tells the main agent why
- Piagent: `managed-harness-conformance` › a helper role already running in the conversation is not started twice
- Piagent: `managed-helper-roles` › the helpers offered are the ones the Harness enables, in Harness order
- Piagent: `managed-helper-roles` › the prompt and the delegate tool describe only enabled helpers; research takes the web, and code reading too without a scout
- Piagent: `managed-helper-roles` › a scout or verify failure names its role, and a helper the Harness lacks is a tool failure
- Piagent: `managed-helpers` › scout and verify helpers run with their own tools and only when the Harness enables them
- Piagent: `managed-failures` › a helper the harness adds while the member works is offered in the same conversation

### `helper.mode`

`auto` helpers start on the model that serves now and move to the next model once for a failure another model may not have.

- Studio: `TestHelperStartsOnTheModelThatServesNow`
- Piagent: `managed-helper-switch` › a helper refused for its account's usage starts once more on the next model
- Piagent: `managed-helper-switch` › a helper starts again once, and only for a failure another model may not have
- Piagent: `managed-helper-switch` › a helper waiting on a resting account moves to the next model
- Piagent: `managed-helper-switch` › a helper whose account went away starts once more on the next model

### `helper.effort`

Unset runs a helper at its main agent's level; a value fixes it.

- Piagent: `managed-failures` › each role runs at the level Studio grants it, whatever the member picked

### `workflow`

Absent: every step `suggest`, `max_fix_loops` 2. An unknown step value is read as `suggest`. `review` is `off` whatever the policy says when the Harness has no review helper.

- Studio: `TestHarnessWorkflowPolicyAndProcessReport`
- Piagent: `managed-workflow` › policy, checks and review findings are read conservatively

### `workflow.plan`

`suggest` asks for a checklist on multi-step work. `require` refuses edits of a complex task until a plan exists (shell edits included), lets edits through after three refused answers and reports `plan_skipped`, and sends a checklist left open on as new runs while they make progress.

- Piagent: `managed-workflow` › a complex task plans before its first edit; a checklist left open goes on as a new run until it is done
- Piagent: `managed-workflow` › a model that never plans is refused for three answers, then its edit goes through and the turn says so
- Piagent: `managed-workflow` › a shell command that edits files before the required plan is caught; later calls wait for the plan; the turn reports it
- Piagent: `managed-workflow` › outside git, a turn that changed code under a required plan it never wrote still reports it
- Piagent: `managed-workflow` › edits sent with an invented plan tool are all refused; a plan sent as a JSON string is read; v2 reports count unknown tools
- Piagent: `managed-continuation` › a checklist left open is sent on while rounds make progress
- Piagent: `managed-continuation` › Stop, a failure, no checklist, a plan that is only suggested, and the round limit
- Piagent: `managed-continuation` › steps left for later end the turn as done as asked, with the count left

### `workflow.verify`

`suggest` names the repository's checks (AGENTS.md `## Checks`, else what its manifests imply) and never adds a turn. `require` sends a code-changing turn back until a check passes on the final code, at most `max_fix_loops` times, and sends a claim the verify helper marked failed back once before the member decides.

- Piagent: `managed-workflow` › required checks and review: the harness sends the agent back until the final patch is checked and clean
- Piagent: `managed-workflow` › suggested steps never add a turn; a required check that never passes ends the turn as unverified
- Piagent: `managed-workflow` › a check that fails with an error result is counted as failed, not as passed
- Piagent: `managed-workflow` › a check that passed before the turn was cut off is still reported as passed
- Piagent: `managed-objections` › under a required verify a failed claim goes back to the agent, is checked again with its answer, and a lasting failure goes to the member
- Piagent: `managed-objections` › under a suggested verify a failed claim stays the agent's to weigh: no extra turn

### `workflow.review`

`suggest` asks the agent to have the review helper read its patch. `require` makes the harness review the final patch itself, send blocking findings back, have the reviewer judge an answer given instead of a fix, and hand a lasting disagreement to the member.

- Piagent: `managed-workflow` › required checks and review: the harness sends the agent back until the final patch is checked and clean
- Piagent: `managed-workflow` › a change the agent commits during the turn is still checked and reviewed
- Piagent: `managed-workflow` › a patch above the shell output limit is still reviewed; a review that cannot run says why
- Piagent: `managed-workflow` › the harness reviews a patch larger than one reviewer reads in parts
- Piagent: `managed-objections` › an answer instead of a fix goes back to the reviewer, who withdraws the finding or keeps it for the member
- Piagent: `managed-objections` › after a fix the reviewer also reads the answer the agent gave with it

### `workflow.max_fix_loops`

0 to 3; anything else is read as 2. With 0 nobody is sent back, but a required review still runs once.

- Piagent: `managed-workflow` › suggested steps never add a turn; a required check that never passes ends the turn as unverified
- Piagent: `managed-harness-conformance` › max_fix_loops is read within 0 to 3 and falls back to 2

### `workflow.lanes`

On unless set to `false` (Agent Studio does not offer this setting yet). The configured plan, verify and review policy is the standard lane, sized on the patch the run made: a tiny change (at most 2 files and 40 changed lines, no sensitive file) ends after its checks without a review; a risky change (a complex request, a migration, auth, security, CI, dependency or `AGENTS.md` file, more than 12 files or 400 lines) has a suggested check and review required. A step set to `off` stays off.

- Piagent: `managed-workflow` › risk lanes size the patch: tiny drops the review, risky requires what was suggested, off stays off
- Piagent: `managed-workflow` › with lanes, a tiny change ends after its checks without the required review
- Piagent: `managed-workflow` › with lanes, a change to a migration has its suggested check and review required

### `workflow.main_web_lookups`

0 to 5; anything else is read as 0 (Agent Studio does not offer this setting yet). With a research helper, the main agent keeps that many web_search or web_fetch calls per member message for a quick fact; the rest of the web work goes to the research helper.

- Piagent: `managed-helper-roles` › with a research helper the main agent may keep a few quick web lookups per message

### `fast_mode`

Off unless the Harness allows it. Only the main agent's calls on a model that serves the priority tier ask for it; a refusal puts the conversation back to standard speed.

- Studio: `TestFastModeNeedsTheHarnessAndIsChargedAtItsWeight`
- Piagent: `managed-fast-mode` › fast mode exists only where the Harness allows it, and starts off
- Piagent: `managed-fast-mode` › only the main agent's call on a model that serves fast mode asks for the priority tier
- Piagent: `managed-fast-mode` › a refused fast request puts the conversation back to standard speed

## Behaviour the Harness implies

### `objections`

A helper may object to its brief with evidence; it never decides. The main agent answers; the same objection a second time goes to the member.

- Piagent: `managed-objections` › a corrected brief answers the objection without another turn
- Piagent: `managed-objections` › an objection the agent never answers with a new brief is answered to the member once; the helper read the member request
- Piagent: `managed-objections` › a second objection from the same helper stops the exchange: the member decides and the helper is refused until then

### `process_report`

Every run closes with its process report, in the version the broker negotiates (v1 to v3). A broker without reports, or a Studio that refuses one, still closes the run.

- Studio: `TestHarnessWorkflowPolicyAndProcessReport`
- Piagent: `managed-workflow` › a broker without process reports, or a Studio that refuses one, still closes the run
- Piagent: `managed-objections` › a helper that objected twice is refused until the member answers; reports keep older versions unchanged

### `interrupted_turn`

A change made by a turn that stopped before its process ran is settled by the next turn.

- Piagent: `managed-workflow` › a change of a turn that stopped before its process ran is settled by the next one ("continue")
- Piagent: `managed-workflow` › stopping while a helper runs ends the turn as stopped, not as a failed request
