# Model selector and scope

Pi Agent Platform không khóa vào một provider. OpenAI Codex và Claude/Anthropic đều là first-class option.

Quan trọng: flow chính là user chọn model bằng native Pi selector, không phải hỏi agent recommend.

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

Global setup của repo sẽ seed `enabledModels` vào `~/.pi/agent/settings.json`, nên sau OAuth anh chọn/đổi model bằng option selector của Pi.

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

Lưu ý: `--list-models` chỉ hiện model mà Pi xem là available với credential/provider hiện tại. Nếu chưa login Anthropic, Claude có thể chưa hiện dù model catalog local có metadata.

## Thinking levels

Pi hỗ trợ:

```text
off, minimal, low, medium, high, xhigh, max
```

Không phải model nào cũng hỗ trợ mọi level. Pi sẽ clamp theo capability của model. Cách chọn:

```bash
pi --model openai-codex/gpt-5.5:high
pi --model anthropic/claude-sonnet-5:xhigh
pi --thinking medium
```

## Current latest-family catalog

Đừng giới hạn vào vài ví dụ. Sau `pi update --models`, kiểm tra catalog local bằng `piagent-models`. Ở release hiện tại, các family/presets chính cần nhớ:

### OpenAI Codex

| Model | Role gợi ý | Khi dùng |
|---|---|---|
| `openai-codex/gpt-5.3-codex-spark` | fast scout | hỏi nhanh, thao tác nhỏ, chi phí thấp |
| `openai-codex/gpt-5.4-mini` | fast/cheap | scout nhẹ, docs, simple fix |
| `openai-codex/gpt-5.4` | balanced | task bình thường |
| `openai-codex/gpt-5.5` | balanced/hard default | default mạnh cho implement |
| `openai-codex/gpt-5.6-luna` | focused hard | debug/review/test khó, cần reasoning sâu nhưng scope hẹp |
| `openai-codex/gpt-5.6-sol` | strategic/deep | architecture, large refactor, planning lớn |
| `openai-codex/gpt-5.6-terra` | huge-context scout | đọc nhiều docs/source, tổng hợp repo lớn |

### Claude / Anthropic

| Model | Role gợi ý | Khi dùng |
|---|---|---|
| `anthropic/claude-haiku-4-5` | fast/cheap | hỏi nhanh, docs/scout nhẹ |
| `anthropic/claude-sonnet-4-5` | balanced | task source bình thường |
| `anthropic/claude-sonnet-4-6` | balanced/deep | source task lớn hơn, max-capable |
| `anthropic/claude-sonnet-5` | balanced/hard default | Claude default mạnh cho implement |
| `anthropic/claude-opus-4-5` | deep | review/refactor lớn |
| `anthropic/claude-opus-4-6` | deep/max | architecture/reasoning nặng |
| `anthropic/claude-opus-4-7` | deep/xhigh/max | high-risk/debug/architecture |
| `anthropic/claude-opus-4-8` | deep/xhigh/max | deep default nếu có quyền dùng |
| `anthropic/claude-fable-5` | huge-context/deep | repo/docs rất lớn, synthesis dài |

Pi catalog có thể có thêm dated variants như `*-2025xxxx`. Dùng alias latest-family ở trên cho team flow, dùng dated version khi cần reproducibility.

## Recommended presets

Preset dưới đây là cách mình seed `enabledModels`, không phải giới hạn hard. User vẫn có thể mở `/model` để chọn bất kỳ model available nào trong provider catalog.

| Preset | OpenAI Codex example | Claude/Anthropic example | Khi dùng |
|---|---|---|---|
| Fast scout | `openai-codex/gpt-5.4-mini:low` | `anthropic/claude-haiku-4-5:low` | đọc nhanh, hỏi đáp, grep/scout nhẹ |
| Balanced implement | `openai-codex/gpt-5.5:medium` | `anthropic/claude-sonnet-5:medium` | task source bình thường |
| Hard implement | `openai-codex/gpt-5.6-luna:xhigh` hoặc `openai-codex/gpt-5.5:xhigh` | `anthropic/claude-sonnet-5:xhigh` | task nhiều file, contract mapping, debug khó |
| Strategic/deep | `openai-codex/gpt-5.6-sol:xhigh` | `anthropic/claude-opus-4-7:max` hoặc `anthropic/claude-opus-4-8:max` | architecture, large refactor, high-risk review |
| Huge-context scout | `openai-codex/gpt-5.6-terra:xhigh` | `anthropic/claude-fable-5:max` | đọc nhiều docs/context, tổng hợp repo lớn |

Tên model có thể đổi theo Pi model catalog. Khi không chắc, ưu tiên `/model` hoặc `pi --list-models`.

## Practical routing

Global setup mặc định:

```bash
piagent-model-scope --preset full --default-model openai-codex/gpt-5.5:xhigh
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
piagent-model-scope --preset full --default-model openai-codex/gpt-5.6-sol:xhigh
piagent-model-scope --preset full --default-model anthropic/claude-sonnet-5:xhigh
```

## Benchmark rule

Không claim “Pi + provider X tiết kiệm hơn provider Y” bằng cảm giác. Chạy cùng scenario rồi ghi bằng:

```bash
piagent-usage /path/to/project
bash scripts/quality-benchmark.sh /path/to/project --record \
  --scenario bounded-source-fix \
  --surface pi \
  --result pass \
  --tokens <total> \
  --cost <cost> \
  --verify "<verify-command>" \
  --notes "provider/model/thinking=<provider/model:thinking>"
```

So sánh tối thiểu:

- Pi + Codex fast/balanced/deep;
- Pi + Claude fast/balanced/deep;
- any other approved setup nếu team muốn so sánh bằng số liệu.
