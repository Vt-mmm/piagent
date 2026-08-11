# Vong doi task trong Pi Agent Platform

## Muc tieu

Tu `v1.2.11`, mot source task duoc quan ly theo chuoi khép kín:

```text
session name -> task contract v2 -> scoped work plan -> observed changes
-> exact verification -> immutable outcome -> retry evidence
```

Runtime guard thi hanh chuoi nay. Prompt chi huong dan agent, khong phai lop
enforcement chinh.

## Luong lam viec hang ngay

1. Mo project bang Pi va dat ten session theo task noi bo.
2. Neu quen dat luc mo, chay `/name <task/session name>` hoac `/setname`.
3. Chay `/workflow task <yeu cau>` de implement, hoac `/workflow scout <yeu cau>`
   de chi doc.
4. Runtime tu tao Task Implementation Contract cho task nho, ro scope va gan voi
   dung Pi session truoc model turn dau tien.
5. Agent lam viec ngay bang read/edit/bash thuong va chay exact verifier runtime
   cung cap. Chi task rong, high-risk hoac scope mo ho moi can goi
   `piagent_task_start` mot lan. Runtime tu ghi context, changed files, verify,
   trace va gate.
6. Neu dong terminal, resume dung session cu bang `pi --continue`, `pi --resume`
   hoac `pi --session <id-or-file>`. Task dang mo duoc map lai theo session id va
   custom trace cua Pi; session name van dung cho Agent Watch/report.

Mot Pi session chi thuoc mot task, ke ca sau khi task da completed/failed. Task
moi hoac retry phai dung session moi. Quy tac nay ngan hai cong viec tron prompt,
usage va changed-file evidence vao mot report.

## Nam pha

### 1. Research

- `/workflow scout` tao luong read-only khi chua can sua source.
- Pi Context Engine tim file/symbol/test bang FTS, import graph va Git signals.
- Memory, Context7, source checkout va document reader la advisory evidence;
  agent van phai doc file hien tai truoc khi sua.
- Auto-context chi inject mot bounded pack cho moi prompt trong tung session.
  Goi pack lai voi cung query se tra reuse marker, khong nhan doi payload/token.

### 2. Plan

Automatic intake hoac fallback `piagent_task_start` tao contract schema v2 gom:

| Nhom | Field chinh |
|---|---|
| Identity | `taskRunId`, `taskId`, `sessionId`, `sessionName`, `intakeMode` |
| Retry | `attempt`, `maxAttempts`, `previousAttempts` |
| Boundary | `changeMode`, `scope`, `outOfScope`, `protectedPaths` |
| Quality | `acceptanceCriteria`, `verifyGroup`, `verifyCommands`, `reviewLenses` |
| Execution | `workPlan`, `orchestration` |
| Evidence | context, memory, baseline/observed/final file digests, verify, trace |

Source task bat buoc nam trong Git working tree. Khong co Git thi runtime tu
choi source-change vi khong the chung minh file nao da doi; read-only scout van
hoat dong.

Work plan toi da 12 step, dependency khong duoc thieu, tu tham chieu hoac tao
cycle. Source task `tiny` tu dong hoan tat lifecycle; source task `normal` tu
dong ghi objective evidence va giu mot explicit review step. Read-only task dung
plan `scout`/`review`, khong con step `implement` mau thuan. Task high-risk/custom
van giu checkpoint thu cong. Chi dung subagent cho scout, planning hoac review
doc lap. Mot write set chi co mot owner.

Trajectory khong suy dien quyen sua tu loi model noi. Automatic source task chi
chuyen sang `execute` khi contract do runtime tao co bounded scope, exact
verifier, acceptance receipt va mot step `single-writer` dang `in-progress` voi
toan bo dependency da xong. Runtime ghi ro phase nao khong ton tai trong automatic
plan neu can bo qua. Manual/high-risk task vao phase `plan` de doc, tim va cap
nhat checkpoint; edit/write/bash ghi file van bi chan cho den khi plan/challenge
hoan tat va step `single-writer` thuc su dependency-ready.

### 3. Execute

Truoc khi co task contract, project da onboard chi cho inspection co gioi han;
write/edit va shell command that su ghi file bi chan. Sau khi task bat dau:

- phase `intake`, `scout` va `plan` chi cho discovery; `execute`/`repair` moi co
  mutation tools, con read-only task khong bao gio nhan quyen mutation;
- direct tool va MCP write phai nam trong `scope`;
- read-only task chan moi project/external mutation;
- protected path, secret redaction, destructive command va external confirmation
  van manh hon task gate;
- tool result ghi nhan file da quan sat thay doi;
- file da dirty truoc task chi tinh la thay doi cua task neu digest sau task khac
  baseline;
- rename ghi nhan ca source va destination.

### 4. Verify va complete

Moi lenh trong `task.verifyCommands` phai duoc Pi `bash` chay that sau thoi diem
task bat dau. Hook `tool_result` tu ghi evidence khi command identity khop plan;
tool `piagent_verify_record` chi con la recovery surface va van phai khop ledger
`.pi/piagent-state/observed-bash.jsonl`.

Gate completed yeu cau dong thoi:

- context manifest theo policy;
- moi verify command co observed result `exitCode=0` va exact match;
- work plan khong con `pending`, `in-progress` hoac `failed`;
- declared changed files khop final digest sau baseline; file da revert khong tinh;
- khong co file ngoai `scope`;
- final trace la `completed`.

`true`, `echo ok`, `npm test || true` hoac command gan giong khong thay the lenh
verify da chot. Hard completion hook tu project final state, check gate va ghi
completed trace. Evidence verify chi hop le cho working-tree digest hien tai;
sua tiep sau verify buoc phai chay lai. Neu automatic/assisted task dung som,
runtime gui dung mot follow-up correction turn voi missing reasons that, sau do
khong loop.

Sau terminal outcome (`completed`, `blocked`, `partial`, `failed`), contract la
immutable. Agent khong the chen them context/verify/change evidence de viet lai
lich su.

### 5. Fail va retry

`workPlan[].status` co `failed`. Final failure ghi `failedAt`, `failureReason`,
`ruledOut` va friction. Session moi dung cung `taskId` tao attempt tiep theo va
mang theo toi da 10 attempt summaries.

`maxAttempts` duoc khoa tu attempt dau (mac dinh 3, toi da 10). Sua tay attempt
sau khong the nang tran. Completed task khong duoc mo lai bang cung `taskId`;
cong viec moi phai co ID moi.

## Migration va local state

Session start va `piagent-update --project <path>` deu nhan biet contract v1.
Migration:

- preview truoc khi ghi;
- tu choi toan bo neu co state unreadable/corrupt;
- tao contract v2 roi archive v1, co the chay lai sau interruption;
- chi map legacy task vao session resume khi custom Pi trace chung minh dung task;
- khong yeu cau onboard lai project.

State, telemetry va capture nam trong `.pi/piagent-state/`, mode owner-only. Moi
writer dung chung local-state boundary, tu choi `.pi`/ancestor symlink thoat
project. JSONL duoc rotate co lock lien process; capture gioi han 500 file,
128 MiB va 30 ngay.

## Lien quan

- [Task Implementation Contract](task-implementation-contract.md)
- [Runtime harness standard](runtime-harness-standard.md)
- [Pi Context Engine](context-engine.md)
- [Command reference](command-reference-vietnamese.md)
- [Usage observability](usage-observability.md)
