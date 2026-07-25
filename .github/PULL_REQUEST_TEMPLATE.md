## What changed

<!-- One or two sentences. What behavior is different after this? -->

## Why

<!-- The problem this solves. For a bug fix, the failure mode. -->

## Verification

<!-- Commands you actually ran, and their result. -->

```bash
npm run verify
```

## Checklist

- [ ] Runs through Pi only — no standalone CLI, hook adapter, or CI-only enforcement surface added
- [ ] Enforcement changes (guard, policy, capability, redaction) have a test that fails before and passes after
- [ ] No existing test was weakened to make this pass
- [ ] `npm run verify` passes
- [ ] Adapter or pack changes: `npm run capabilities:catalog` re-run and the diff committed
- [ ] Docs updated only if behavior, setup, commands, architecture, or security posture changed
- [ ] No secrets, `.env` files, tokens, or personal data committed
