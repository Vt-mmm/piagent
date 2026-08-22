# Model selector and scope
<!-- language: vi; english-index: docs-site/content/en/quickstart.html -->

Pi Agent Platform không khóa vào một provider. Hai họ model dưới đây đều là first-class option: **model OpenAI Codex** (provider id `openai-codex`) và **model Claude của Anthropic** (provider id `anthropic`).

Lưu ý cách đọc: trong toàn bộ tài liệu này, "Codex" và "Claude" là **tên họ model** đứng sau các provider id ở trên. Chúng không phải tên CLI, và cũng không phải một agent nào khác — mọi thứ ở đây đều chạy trong Pi.

Flow mặc định vẫn là user chọn model bằng native Pi selector. Adaptive routing
chỉ hoạt động khi operator chọn mode tương ứng; `/model`, CLI `--model`, hoặc
`--thinking` là hard pin và luôn thắng router.

## Capability routing trước task

Piagent có contract `low | medium | high | ultra`, tách khỏi tên model cụ thể.
Mapping đánh giá OpenAI hiện tại là Luna/medium, Terra/medium, Sol/high và
Sol/xhigh; authenticated catalog phải có đúng model/effort, nếu không decision
trả `unavailable` thay vì substitute.

```text
PIAGENT_PARENT_ROUTING=off|shadow|recommend|auto
PIAGENT_ROUTING_OBJECTIVE=intelligence|balance|cost
```

- `shadow`: tính và lưu decision đã redaction, không đổi model.
- `recommend`: hiện band/model/effort và reason trong `/task-preflight`.
- `auto`: extension hiện fail-closed về recommend. Task-boundary adapter an toàn
  là lệnh prelaunch rõ ràng:

```bash
piagent-route --prompt "Fix src/parser.ts and run npm test" --json
piagent-route --prompt-file /path/to/task.txt --execute --yes -- --approve
```

`--execute --yes` mới bắt đầu provider-backed task. Router từ chối explicit pin,
task chưa qua preflight, catalog thiếu, hoặc decision không đủ điều kiện. Nó
không đổi model giữa thread và không ghi raw prompt vào route evidence.

## Flow chuẩn sau OAuth

Trong Pi:

```text
/login
/model          # hoặc Ctrl+L
/scoped-models  # optional, edit danh sách Ctrl+P cycle
```

Hotkeys:

```text
Ctrl+L          # mở model selector
Ctrl+P          # cycle model trong enabledModels
Shift+Ctrl+P    # cycle ngược
Shift+Tab       # cycle thinking level
```

Global setup của repo sẽ seed các preset đã kiểm chứng và một catch-all
`openai-codex/*` vào `~/.pi/agent/settings.json`. Vì các preset đứng trước glob,
chúng giữ thinking level khuyến nghị; model Codex mới trong authenticated catalog
vẫn tự xuất hiện trong scope mà không cần chờ Piagent phát hành lại.

## Kiểm tra model hiện có

Trong Pi:

```text
/login
/model
/settings
/scoped-models
```

Từ terminal:

```bash
pi --list-models
pi --list-models openai-codex
pi --list-models claude
pi --list-models anthropic
piagent-models
piagent-models --provider openai-codex
piagent-models --provider anthropic
```

Lưu ý: `--list-models` và `piagent-models` chỉ hiện model mà Pi xem là
available với credential/provider hiện tại. `piagent-models --json` ghi rõ
`authenticated`, `logged-out`, `offline` hoặc `unavailable`; nó không đọc public
catalog rồi trình bày như quyền truy cập đã xác thực. Nếu một model đã seed vào
scope nhưng chưa available, report giữ nguyên tên và cảnh báo, không substitute
sang model khác.

## Thinking levels

Pi hỗ trợ:

```text
off, minimal, low, medium, high, xhigh, max
```

Không phải model nào cũng hỗ trợ mọi level. Pi sẽ clamp theo capability của model. Cách chọn:

```bash
pi --model openai-codex/gpt-5.6-sol:high
pi --model anthropic/claude-sonnet-5:xhigh
pi --thinking medium
```

## Current latest-family catalog

Đừng giới hạn vào vài ví dụ. Sau `pi update --models`, kiểm tra catalog local bằng `piagent-models`. Ở release hiện tại, các family/presets chính cần nhớ:

### Họ model OpenAI Codex

| Model | Role gợi ý | Khi dùng |
|---|---|---|
| `openai-codex/gpt-5.3-codex-spark` | fast scout | hỏi nhanh, thao tác nhỏ, chi phí thấp |
| `openai-codex/gpt-5.4-mini` | fast/cheap | scout nhẹ, docs, simple fix |
| `openai-codex/gpt-5.4` | balanced | task bình thường |
| `openai-codex/gpt-5.5` | balanced/hard | model thế hệ trước vẫn được hỗ trợ khi có trong authenticated catalog |
| `openai-codex/gpt-5.6-luna` | cost-sensitive/high-volume | workload nhanh, nhiều lượt, ưu tiên latency và chi phí |
| `openai-codex/gpt-5.6-terra` | balanced | công việc hằng ngày cần cân bằng capability, speed và cost |
| `openai-codex/gpt-5.6-sol` | frontier/quality-first | task phức tạp, long-horizon hoặc cần chất lượng cao nhất |

### Họ model Claude (Anthropic)

| Model | Role gợi ý | Khi dùng |
|---|---|---|
| `anthropic/claude-haiku-4-5` | fast/cheap | hỏi nhanh, docs/scout nhẹ |
| `anthropic/claude-sonnet-4-5` | balanced | task source bình thường |
| `anthropic/claude-sonnet-4-6` | balanced/deep | source task lớn hơn, max-capable |
| `anthropic/claude-sonnet-5` | balanced/hard default | model default mạnh cho implement |
| `anthropic/claude-opus-4-5` | deep | review/refactor lớn |
| `anthropic/claude-opus-4-6` | deep/max | architecture/reasoning nặng |
| `anthropic/claude-opus-4-7` | deep/xhigh/max | high-risk/debug/architecture |
| `anthropic/claude-opus-4-8` | deep/xhigh/max | deep default nếu có quyền dùng |
| `anthropic/claude-fable-5` | huge-context/deep | repo/docs rất lớn, synthesis dài |

Pi catalog có thể có thêm dated variants như `*-2025xxxx`. Dùng alias latest-family ở trên cho team flow, dùng dated version khi cần reproducibility.

## Recommended presets

Preset dưới đây là benchmark seed cho `enabledModels`, không phải universal
routing truth hay giới hạn hard. User vẫn có thể mở `/model` để chọn bất kỳ model
available nào trong authenticated provider catalog.

| Preset | Model OpenAI Codex | Model Claude (Anthropic) | Khi dùng |
|---|---|---|---|
| Fast scout | `openai-codex/gpt-5.4-mini:low` | `anthropic/claude-haiku-4-5:low` | đọc nhanh, hỏi đáp, grep/scout nhẹ |
| Balanced implement | `openai-codex/gpt-5.6-terra:medium` | `anthropic/claude-sonnet-5:medium` | task source bình thường |
| Cost-sensitive volume | `openai-codex/gpt-5.6-luna:medium` | `anthropic/claude-haiku-4-5:low` | workload nhanh, nhiều lượt; đo quality gate trước khi promote |
| Balanced implement | `openai-codex/gpt-5.6-terra:high` hoặc `openai-codex/gpt-5.5:high` | `anthropic/claude-sonnet-5:high` | task source hằng ngày, cân bằng capability/cost |
| Frontier/quality-first | `openai-codex/gpt-5.6-sol:high` | `anthropic/claude-opus-4-7:xhigh` hoặc `anthropic/claude-opus-4-8:xhigh` | architecture, long-horizon, high-risk review |

Tên model có thể đổi theo Pi model catalog. Khi không chắc, ưu tiên `/model` hoặc `pi --list-models`.

## Practical routing

Global setup mặc định:

```bash
piagent-model-scope --preset full --default-model openai-codex/gpt-5.6-sol:high
```

Scope này ghi vào settings:

```bash
~/.pi/agent/settings.json
```

Sau đó dùng selector:

```text
/model
/scoped-models
Ctrl+P
Shift+Tab
```

Nếu muốn đặt default khác:

```bash
piagent-model-scope --preset full --default-model openai-codex/gpt-5.6-sol:high
piagent-model-scope --preset full --default-model anthropic/claude-sonnet-5:xhigh
```

## Benchmark rule

Không claim “Pi + provider X tiết kiệm hơn provider Y” bằng cảm giác. Pin model
và thinking rồi chạy automatic paired benchmark:

```bash
piagent-benchmark --dry-run --model <provider/model> --thinking high
piagent-benchmark --model <provider/model> --thinking high
```

Runner đọc model/thinking/token/cost từ Pi session và chỉ kết luận efficiency
khi quality/safety gates vẫn đạt. Dùng một report riêng cho mỗi model preset.

Khi migrate model family, giữ effort hiện tại làm baseline rồi chạy cùng effort
và đúng một level thấp hơn trên representative tasks. Ví dụ baseline `high` thì
so `high` với `medium`; không đặt `xhigh` hay `max` làm mặc định chung chỉ vì
model hỗ trợ level đó. Promote seed chỉ khi paired report giữ quality, safety,
reliability và workflow gate.

So sánh tối thiểu:

- Pi + model Codex ở fast/balanced/deep;
- Pi + model Claude ở fast/balanced/deep;
- any other approved setup nếu team muốn so sánh bằng số liệu.

`/task-preflight` và `/piagent-status` chỉ report model/effort/context có
provenance từ Pi runtime hoặc authenticated catalog. Solver/helper không tự đổi
parent model đã pin. Nếu fact chưa có ngoài Pi session, UI ghi `unknown`; không
substitute model và không ước lượng token/cost.
