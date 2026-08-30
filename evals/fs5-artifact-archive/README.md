# Frozen FS5 artifact archive

This directory preserves the declared input bytes of FS5 protocols v1–v5.
It is read-only historical evidence, not an executable candidate, a successful
benchmark result, or permission to restart a closed campaign.

The 17 distinct path/digest bindings occupy 458,632 uncompressed bytes. They
were recovered from existing local Git objects and checked against every
protocol's original SHA-256. Each `.txt` file contains exact source bytes,
including the final newline, and is named by its content digest. Archived
JavaScript is never imported or executed by the archive test.

`manifest.json` binds the unchanged protocol file bytes and lists each artifact
path, digest, byte length and retrieval commit. `retrievedFromCommit` means a
commit from which these exact bytes were obtained; it does **not** assert that
this was the original campaign's candidate commit. The archive is deliberately
self-contained so reading it does not require Git history or network access.

`tests/helpers/fs5-artifact-archive.mjs` checks every byte length and digest,
every declared artifact across all five protocols, and the absence of unused
archive entries. No historical protocol hash is updated to match current code.

Production preflight/execution argument construction uses only files under the
current checker repository. The archive is never a fallback for a mismatched
or missing current file, and callers cannot override the checker's root. The
full benchmark runner's candidate snapshot, authorization and stage gates are
still required independently of this file-binding check.

Checksums detect corruption or mismatch under the trusted-repository model.
They are not signed provenance or protection against somebody who can replace
both source and its expected hashes. No SLSA level or reproducible-build
certification is claimed.
