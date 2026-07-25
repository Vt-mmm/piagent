# Project Context

## Status

- Generated: 2026-07-18 bootstrap baseline
- Profile: `platform-development` / `piagent-platform`
- Model/pass: hand-maintained bootstrap; run `/onboard-project` inside Pi when this platform repo needs a refreshed context snapshot
- Scope: Pi Agent Platform repository

## Purpose

This repo is the reusable Pi Agent Platform package/scaffold. It owns global prompts, skills, guard extensions, project adapters, setup scripts, templates, and Vietnamese documentation for team rollout.

## Current source of truth

- `README.md`: team-facing quickstart.
- `docs/architecture.md`: platform architecture.
- `docs/project-adapters.md`: built-in project profiles and auto-detect behavior.
- `docs/distribution-standard.md`: sharing/release rules.
- `packages/piagent-core/`: Pi package content.
- `scripts/`: setup/init/doctor/verification scripts.

## Update triggers

Regenerate with `/onboard-project` when setup flow, adapters, package manifest, guard tools, or distribution policy materially changes.
