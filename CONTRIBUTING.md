# Contributing

Thanks for considering a contribution.

This platform is a governance layer for the [Pi coding agent](https://github.com/badlogic/pi-mono): project profiles, capability packs, protected paths, tool policy, and verification evidence. It runs as a Pi package and is not intended to run outside Pi — proposals that add non-Pi execution surfaces (standalone policy CLIs, hook adapters for other agents, CI-only enforcement) are out of scope.

## Before you start

- Open an issue first for anything beyond a typo or a doc fix. It is cheaper to align on approach than to rework a finished branch.
- Security issues do not go in issues or pull requests. Follow [SECURITY.md](SECURITY.md).

## Setup

Requires Node.js `>=22.19.0`.

```bash
npm install
npm run verify
```

`npm run verify` runs the full local gate. Individual checks:

```bash
npm test                    # node --test over tests/
npm run typecheck           # tsc --noEmit
npm run capabilities:check  # capability catalog is in sync
npm run doctor              # environment and project wiring
```

## Adding an adapter profile

Adapters are the most common contribution and the easiest place to start. An adapter is a single JSON file describing how the agent should behave in one kind of repository — which paths are protected, which context files must be read, which commands verify a change.

1. Create `adapters/<name>/profile.json`. Copy the closest existing profile and adjust; `adapters/generic/profile.json` is the safest baseline.
2. Validate against [`schemas/project-profile.schema.json`](schemas/project-profile.schema.json).
3. Keep `verifyCommands` real. They must be commands that actually exist in that ecosystem and actually fail on a broken change — a verification command that always passes is worse than none.
4. Set `protectedPaths` from what the ecosystem genuinely must not have rewritten: lockfiles, generated code, migration history, credential files.
5. Regenerate the catalog and run the gate:

```bash
npm run capabilities:catalog
npm run verify
```

Adapters currently live in this repository. Open an issue if you want to discuss distributing one outside it.

## Changing enforcement code

Guard, policy, capability, and redaction changes need a test that fails before the change and passes after. State in the pull request what the failure mode was.

Do not weaken an existing test to make a change pass. If a test encodes the wrong rule, say so explicitly and change the rule deliberately.

## Documentation

Update `docs/` only when behavior, setup, commands, architecture, or security posture actually changed. Internal refactors do not need a docs entry.

## Commits and pull requests

- Conventional commit format: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- Describe the invariant a change protects, not the plan or phase it came from.
- Never commit secrets, `.env` files, tokens, private keys, or personal data.
- One logical change per pull request.

## License

Contributions are licensed under the MIT License, as in [LICENSE](LICENSE).
