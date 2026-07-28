---
description: Explain native Pi model selector/scope options across model families
argument-hint: "[task type, budget, or provider preference]"
---

Explain Pi provider/model/thinking selector options for:

```text
$ARGUMENTS
```

Mandatory flow:

1. Call `piagent_context`.
2. Call `piagent_usage_snapshot` if the user asks about current model/context/cost.
3. Make clear that model switching is done by Pi native UI, not by agent deciding for the user:
   - `/model` or Ctrl+L for selector;
   - `/scoped-models` for cycle scope;
   - Ctrl+P / Shift+Ctrl+P for model cycling;
   - Shift+Tab for thinking level.
4. Include both model families — the OpenAI Codex models and the Anthropic Claude models — unless the user explicitly restricts the provider. Name them as model families, never as another tool.
5. Do not limit the answer to one or two legacy examples. Include the current latest-family options: the Codex 5.5/5.6 models and the Claude Sonnet/Opus/Fable models, where relevant.
6. If the user needs available model versions, recommend `piagent-models`, `/model`, or `pi --list-models`.
7. Explain thinking levels as task effort, not as quality guarantee.
8. Do not claim token/cost savings without benchmark evidence.

Current latest-family catalog to consider:

OpenAI Codex models (provider `openai-codex`):

- `openai-codex/gpt-5.3-codex-spark`
- `openai-codex/gpt-5.4-mini`
- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.5`
- `openai-codex/gpt-5.6-luna`
- `openai-codex/gpt-5.6-sol`
- `openai-codex/gpt-5.6-terra`

Anthropic Claude models (provider `anthropic`):

- `anthropic/claude-haiku-4-5`
- `anthropic/claude-sonnet-4-5`
- `anthropic/claude-sonnet-4-6`
- `anthropic/claude-sonnet-5`
- `anthropic/claude-opus-4-5`
- `anthropic/claude-opus-4-6`
- `anthropic/claude-opus-4-7`
- `anthropic/claude-opus-4-8`
- `anthropic/claude-fable-5`

Default selector scope seeded by setup:

| Preset | OpenAI Codex model | Anthropic Claude model | Use when |
|---|---|---|---|
| Fast scout | `openai-codex/gpt-5.4-mini:low` | `anthropic/claude-haiku-4-5:low` | quick reads, simple Q&A |
| Balanced implement | `openai-codex/gpt-5.5:medium` | `anthropic/claude-sonnet-5:medium` | normal source tasks |
| Hard implement | `openai-codex/gpt-5.6-luna:xhigh` or `openai-codex/gpt-5.5:xhigh` | `anthropic/claude-sonnet-5:xhigh` | multi-file/debug/contract mapping |
| Strategic/deep | `openai-codex/gpt-5.6-sol:xhigh` | `anthropic/claude-opus-4-7:max` or `anthropic/claude-opus-4-8:max` | architecture, large refactor, high-risk review |
| Huge-context scout | `openai-codex/gpt-5.6-terra:xhigh` | `anthropic/claude-fable-5:max` | large repo/docs synthesis |

Output:

- Current model/context if available.
- How to open/select/change model in Pi UI.
- What `enabledModels`/scope contains.
- Codex model family options.
- Claude model family options.
- How to inspect/re-apply model scope from terminal.
