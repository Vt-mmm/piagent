# Task Implementation Contract v2
<!-- language: en -->

## Muc tieu

Contract la state machine cuc bo giup Pi chung minh mot task da doc gi, duoc sua
gi, da thay doi gi, verify bang lenh nao va ket thuc ra sao. File nam tai:

```text
.pi/piagent-state/tasks/<taskRunId>.json
.pi/piagent-state/session-tasks/<session-id-hash>.json
```

`taskId` la ten logic cua cong viec. `taskRunId` la identity duy nhat cua mot
attempt. `sessionId` rang attempt vao dung Pi session; `sessionName` de resume va
Agent Watch/report hien ten task ma operator da dat.

## Field groups

| Nhom | Field | Quy tac |
|---|---|---|
| Schema | `schemaVersion` | Luon la `2`. |
| Identity | `taskRunId`, `taskId`, `sessionId`, `sessionName`, `intakeMode` | Run ID/Task ID normalized; mot session chi co mot task; intake la `runtime` hoac `model`. |
| Mode | `changeMode` | `source-change` hoac `read-only`. |
| Retry | `attempt`, `maxAttempts`, `previousAttempts` | Tran lay tu attempt dau, khong duoc nang o retry sau. |
| Intent | `summary`, `riskLane`, `expectedOutput`, `acceptanceCriteria` | Chot truoc khi implementation. |
| Scope | `scope`, `outOfScope`, `protectedPaths` | Direct write bi chan ngoai scope; final gate doi chieu Git. |
| Context | `requiredContext`, `contextManifest`, `memoryCitations`, `mcpCapabilities` | Citation co path va reason. |
| Verify | `verifyGroup`, `verifyCommands`, `verifyEvidence` | Moi command phai observed, exact-match va pass. |
| Plan | `workPlan`, `reviewLenses`, `orchestration` | Toi da 12 step, dependency DAG, single writer. |
| Changes | baseline/observed/final file lists va digests, `changedFiles` | Phan biet dirty truoc task voi thay doi trong task; ghi ca hai dau rename. |
| Outcome | `trace`, `failedAt`, `failureReason`, `ruledOut` | Terminal contract immutable. |
| Time | `createdAt`, `updatedAt` | Timestamp parseable, dung de sap xep/migration/report. |

Template day du nam tai
[`templates/project/.pi/task-contract.template.json`](../templates/project/.pi/task-contract.template.json).
Schema chinh thuc nam tai
[`schemas/task-contract.schema.json`](../schemas/task-contract.schema.json).

## Runtime lifecycle

```text
runtime automatic intake OR piagent_task_start fallback
  -> ordinary targeted reads + project tool calls
  -> runtime-observed context and changed files
  -> exact bash verify commands
  -> current-tree verify evidence from tool_result
  -> completion hook projects trace + final gate
```

Bounded default source tasks are created and completed through runtime hooks
without model management calls. Broad/high-risk/custom source tasks use manual
intake and explicit checkpoints when required.
Read-only defaults use `scout`/`review`, never an implementation step. Manual
context/verify/trace/gate tools are recovery surfaces for custom/high-risk work.

Task start tu choi khi:

- session da thuoc task khac hoac task terminal;
- cung `taskId` dang pending o session khac;
- task da completed;
- retry vuot `maxAttempts`;
- source task khong o trong Git working tree;
- profile khong co meaningful verifier;
- work plan trung ID, thieu dependency, tu tham chieu hoac co cycle.

Truoc task start, governed project chi cho phep inspection. Guard chi coi shell la
mutation khi command that su co kha nang ghi project (write redirection, mutating
Git/package/file command, interpreter write, `sed -i`, `find -delete`...). Read,
search va test khong bi gan nham thanh write.

## Changed-file truth

Luc start, runtime luu Git working-tree snapshot va digest tung file dirty. Luc
gate/final trace, runtime chup lai snapshot:

```text
expected change = file co final digest khac task-start baseline
```

Vi vay:

- file dirty truoc task khong tu dong bi nhan la do task;
- file dirty truoc task nhung bi sua tiep se duoc tinh;
- file da duoc sua roi revert ve baseline chi nam trong audit history, khong pass gate;
- claim file khong co evidence bi tu choi;
- thay doi ngoai `scope` bi tu choi;
- delete/missing co digest rieng;
- staged rename ghi ca old path va new path.

## Verify truth

Observed bash ledger la bounded owner-only JSONL. Evidence chi pass khi:

```text
exitCode === 0
observed === true
matchedProfileCommand === true
command nam chinh xac trong task.verifyCommands
```

Final gate doi evidence cho **tat ca** meaningful verify commands, khong chi mot
command bat ky. Profile `generic` fail-closed cho source work den khi project khai
verifier. Profile theo stack chi chay command co y nghia va khong dung `|| true`
de che failure.

## Retry va terminal immutability

Step co the `pending`, `in-progress`, `done`, `skipped`, `failed`. Reopen mot
failed step can note moi; step done/skipped khong duoc mo lai. Khi trace da
terminal, cac tool progress/context/memory/verify/trace va project mutations deu
bi chan cho session do.

Retry chay o session moi. `previousAttempts` giu outcome, phase failure, reason,
ruled-out hypothesis va timestamp de agent khong lap lai cach da that bai.

## Migration v1 -> v2

Reader v2 fail-closed voi field la, timestamp hong, nested plan sai, taskRunId
khong khop filename hoac state unreadable. Migrator v1 chi copy whitelist field
da cong bo, them identity/session/retry/baseline defaults, ghi v2 atomically roi
archive file v1. Update preflight tu choi truoc moi project write neu state can
operator recovery.

Project da onboard khong can onboard lai sau global update. Capability lock giu
nguyen grant cua project va chi re-pin core khi release moi khong mo rong quyen.

## Enforcement

| Lop | Enforcement |
|---|---|
| Prompt/workflow | Huong dan dung tool theo thu tu. |
| Tool-call guard | Protected path, scope, read-only, destructive/external confirmation. |
| Tool-result observer | Changed-file va bash evidence tu su kien that. |
| Persisted contract | Session binding, retry, plan, context, verify, trace. |
| Completion hook | Chan completion claim khi gate chua pass. |
| Local-state boundary | Owner-only, atomic write, no ancestor symlink, bounded retention. |
