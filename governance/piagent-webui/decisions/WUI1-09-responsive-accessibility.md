---
plan_id: piagent-webui
work_item: WUI1-09
status: accepted
decision: responsive-accessibility
date: 2026-08-13
---

# WUI1-09 responsive and accessibility behavior

## Decision

The read-only product retains the same authoritative facts from desktop through
narrow mobile layouts. Content reflows without hiding lifecycle, criterion,
source status, verifier or blocker semantics.

The document language is Vietnamese. The app provides skip navigation, named
landmarks, live connection/loading states, keyboard source-tab navigation,
focus-visible treatment, accessible progress values, reduced-motion behavior
and forced-color affordances. Horizontal diff overflow remains reachable rather
than visually clipping source content.

## Acceptance evidence

- Keyboard tests cover ArrowLeft/ArrowRight/Home/End with cyclic tab behavior.
- Static accessibility tests require tab relationships, skip navigation, live
  status, responsive breakpoints, focus, reduced-motion and forced-color rules.
- Typecheck, production build and architecture checks pass.
