# Project Context

## Status

- Generated: not yet
- Profile: see `.pi/piagent-profile.json`
- Model/pass: ask the agent to onboard the project after Pi login and model selection
- Scope: pending

## Purpose

This file is the reusable project context snapshot for Pi Agent Platform.

Before the first real implementation task in this project:

1. Open Pi in the project.
2. Run `/login` if needed.
3. Select the intended provider/model.
4. Ask the agent: "Inspect this project read-only and record its project context."

The selected model should inspect the project read-only, then replace this file with a concise project map, required context, verification matrix, and high-risk areas.

## Update triggers

Ask the agent to refresh it when:

- source layout changes;
- architecture or domain ownership changes;
- test/build commands change;
- auth/data/migration/provider policy changes.
