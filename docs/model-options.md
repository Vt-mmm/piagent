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
pi --model openai-codex/gpt-6-sol:high
pi --model anthropic/claude-sonnet-5:xhigh
pi --thinking medium
```

## Current latest-family catalog

Đừng giới hạn vào vài ví dụ. Sau khi nâng Pi host, kiểm tra catalog đã đăng nhập bằng `piagent-models`. Có tên model trong SDK không đồng nghĩa tài khoản đã được cấp quyền dùng. Các tier dưới đây dựa trên [hướng dẫn chọn model](https://developers.openai.com/api/docs/guides/model-selection) và [catalog chính thức](https://developers.openai.com/api/docs/models), chưa phải kết quả benchmark Piagent–Codex của phiên bản này.

### Họ model OpenAI Codex

| Model | Role gợi ý | Khi dùng |
|---|---|---|
| `openai-codex/gpt-6-luna` | efficient | task rõ phạm vi, khối lượng lớn; tier low của router ở `medium` effort |
| `openai-codex/gpt-6-sol` | balanced coding | công việc hằng ngày; mặc định phiên mới ở `high` effort, tier medium ở `medium` |
| `openai-codex/gpt-6-astra` | frontier | task rộng, mơ hồ, nhiều bước; tier ultra ở `xhigh` |
| `openai-codex/gpt-5.3-codex-spark` | fast scout | hỏi nhanh, thao tác nhỏ, chi phí thấp |
| `openai-codex/gpt-5.4-mini` | fast/cheap | scout nhẹ, docs, simple fix |
| `openai-codex/gpt-5.4` | balanced | task bình thường |
| `openai-codex/gpt-5.5` | balanced/hard | model thế hệ trước vẫn được hỗ trợ khi có trong authenticated catalog |
| `openai-codex/gpt-5.6-luna` | legacy fallback low | dùng khi GPT-6 Luna chưa có trong authenticated catalog |
| `openai-codex/gpt-5.6-terra` | legacy fallback medium | dùng khi GPT-6 Sol chưa có trong authenticated catalog |
| `openai-codex/gpt-5.6-sol` | legacy fallback high/ultra | giữ phiên cũ và benchmark lịch sử; dùng khi GPT-6 Sol/Astra chưa có |

Pi 0.87.1 khai báo cả ba GPT-6 model trên đường `openai-codex` và `openai`. Catalog Codex của Pi hiện khai báo cửa sổ context 272.000 token; tài liệu API công bố 1,05 triệu token. Hãy dùng giới hạn do host/provider của phiên thực tế cung cấp, không lấy giới hạn API để giả định cho đăng nhập Codex. Astra không hỗ trợ thinking `off`; Sol và Luna có hỗ trợ. Router chỉ chọn model/effort khớp đúng catalog đã đăng nhập, ghi `legacy-model-fallback` khi phải chọn 5.6, và vẫn giữ nguyên model người dùng pin rõ ràng.

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
| Focused/volume | `openai-codex/gpt-6-luna:medium` | `anthropic/claude-haiku-4-5:low` | task nhỏ, rõ phạm vi và có cách kiểm tra |
| Balanced implement | `openai-codex/gpt-6-sol:medium` hoặc `:high` | `anthropic/claude-sonnet-5:high` | task source bình thường |
| Frontier/quality-first | `openai-codex/gpt-6-astra:xhigh` | `anthropic/claude-opus-4-8:xhigh` | task rộng, mơ hồ, nhiều bước |

Tên model có thể đổi theo Pi model catalog. Khi không chắc, ưu tiên `/model` hoặc `pi --list-models`.

## Practical routing

Global setup mặc định:

```bash
piagent-model-scope --preset full --default-model openai-codex/gpt-6-sol:high
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
piagent-model-scope --preset full --default-model openai-codex/gpt-6-sol:high
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
