# Offline package lifecycle qualification

The full `d4f80ee` check completed with 3,692/3,693 tests passing, one failure,
zero skips/cancellations, and unchanged source. The failure was `ENOTCACHED`
while installing the candidate's required `ws@8.21.3` into an isolated prefix.
The test created an empty private npm cache but never provisioned dependencies.
The baseline v1.2.17 has no runtime dependencies, so its installation succeeded.

The prior `0d03cff` full runner used `verify-local.sh --offline` but did not force
`npm_config_offline=true`; that script's flag skips the Pi model-catalog check,
not npm registry access. Its PASS remains valid for its actual invocation, but
does not demonstrate registry-independent package installation. The later full
runner enforced npm offline mode and exposed this previously untested condition.
This distinction does not establish whether an earlier request used the network.

## Bounded repair

The lifecycle test now obtains the exact locked runtime tarball using
`npm pack <locked-url> --offline --ignore-scripts`. It independently verifies
the archive's SHA-512 against package-lock before any fixture provisioning. This
requires the existing dependency-setup cache; a missing archive fails instead of
downloading. It does not copy the operator's cache or use installed source as a
substitute for the locked archive.

A temporary server bound only to 127.0.0.1 serves that archive and its metadata.
`npm cache add` populates a fresh private cache using this loopback-only source,
with proxies disabled. The server is closed before all three actual standalone
package installations, which explicitly require `--offline`. This bootstrap
uses local HTTP, not an external registry or model provider.

The cache is populated through npm's public command rather than relying on its
opaque internal storage layout; see [npm cache documentation](https://docs.npmjs.com/cli/v11/commands/npm-cache/).
The helper deliberately supports only the current pinned, unscoped, leaf runtime
dependencies with optional peers. A new dependency shape requires explicit
fixture support. Unknown requests are errors, never external fallbacks.

The original baseline/candidate/rollback source artifacts and candidate dependency
manifest are preserved. Installation still receives only the platform artifact;
supplying a global sibling dependency tarball would not test the same resolution.
All earlier assertions remain, including exact candidate module bytes, removal
on rollback, runnable installed commands and unchanged synthetic operator-state
bytes/modes. New assertions check nested dependency version and package-manifest
bytes against the lock-verified archive. Modified archives are rejected.

## Evidence boundary

The targeted lifecycle and archive-integrity group passed 4/4 with no skips on
native Node 22.19.0 and npm 11.6.2 after this change. This is not a replacement for
the failed full result, a fresh full run, S0, independent custody or the 108-session
campaign. Worker/core source, completion rules and historical campaign data were
not changed. No benchmark model or external-registry download was used for this
repair and its targeted test.
