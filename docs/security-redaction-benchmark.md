# Sensitive-data redaction benchmark
<!-- language: en -->

The redaction benchmark measures the text and structured-data backstop used by the runtime guard. It uses deterministic synthetic values only; real credentials must never be added to the corpus. This is an internal regression benchmark, not an independent security audit, and the detector model should be treated as still maturing.

Run it from the repository root:

```bash
npm run benchmark:redaction
```

The command returns JSON and exits non-zero when a release gate fails.

The v0.4.2 frozen-tree baseline is 52/52 contextual cases detected, 0/30 benign text false positives, 8/8 structured sensitive values redacted, and 7/7 structured benign values preserved. The six unlabeled-entropy cases remain observational and non-gated.

## Release gates

- Every contextual or known-format case must be redacted.
- Benign text must have zero false positives in the committed corpus.
- Structured sensitive fields and approved plural collections must be redacted.
- Structured identifiers, checksums, labels, and semantic/design token fields must remain unchanged.
- A large text result with a contextual credential must be redacted successfully.

The corpus covers known token formats, private-key blocks, credential-bearing URLs, authorization headers, query parameters, quoted and multiline assignments, camelCase/hyphenated keys, nested objects, arrays, placeholders, existing redaction markers, hashes, identifiers, and documentation prose.

## Interpreting the output

| Field | Meaning | Gated |
|---|---|---|
| `contextual` | Known formats or values paired with a credential-bearing key/header/URL context | Yes |
| `benign` | Text that must remain unchanged | Yes |
| `structured` | Key-aware redaction and preservation inside objects/arrays | Yes |
| `largeOutput` | Redaction result for a bounded large text sample | Yes for correctness; timing is informational |
| `unlabeledEntropy` | Opaque values without a credential-bearing context | No; observational only |
| `performance` | Local execution measurements | No; compare only on the same machine/runtime |

Unlabeled high-entropy values are not automatically treated as secrets. A generic entropy rule cannot reliably distinguish a credential from a checksum, content hash, artifact identifier, or opaque public ID. Add a known format or a clear key/header context when stronger coverage is required.

## Security boundary

This benchmark measures pattern-based output containment. It does not authorize secret handling and does not turn the extension into an operating-system sandbox. It does not decode every transformed output form before matching; for example, base64-encoded or otherwise re-encoded secret material can evade the redaction backstop. Workloads that execute untrusted code or process untrusted prompts still require process, filesystem, network, and credential isolation.

The current scope, assumptions, controls, and residual risks are documented in [security-threat-model.md](security-threat-model.md), and private intake/disclosure is documented in [SECURITY.md](../SECURITY.md). Before using redaction results as a stronger assurance claim, continue to complete and maintain:

- Linux, macOS, Windows, and shell-behavior compatibility matrix;
- parser fuzzing for shell/path extraction;
- symlink and path-traversal adversarial tests;
- third-party audit or independent review;
- LTS support and backport policy for affected releases.

When extending the detector:

1. Add synthetic positive and benign controls first.
2. Record the failing benchmark result.
3. Make the smallest context-aware detector change.
4. Run the benchmark, full test suite, typecheck, capability doctor, and offline verification.
5. Keep the unlabeled-entropy result separate from release claims.
