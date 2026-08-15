# WUI2-05 — Bounded file and image attachments

Status: accepted

Date: 2026-08-14

## Decision

The first WebUI attachment release stages only browser-selected file bytes. It
does not accept a filesystem path, URL, archive, directory or provider-owned
object reference. Staging and removing a draft attachment are local control
operations and consume zero model turns. Only the explicit chat Send action may
place staged content into the current Pi session.

The staging authority is the in-process Pi extension. The loopback sidecar only
authenticates and forwards a versioned command. The browser is never an
attachment authority and a second Pi runtime is never started.

## Limits

- At most four attachments per `messageRequestId`.
- At most 16 MiB total per message.
- Image: at most 8 MiB; PNG, JPEG, GIF, WebP or BMP; verified from bytes.
- Text file: at most 256 KiB; UTF-8 text, Markdown or JSON; NUL is rejected.
- At most 64 staged attachments and 64 MiB across one extension runtime.
- Staged references expire after ten minutes and are one-shot.
- The HTTP staging body is capped independently before JSON/base64 decoding.

The capability handshake advertises the effective limits. A smaller runtime
limit wins if a future host constrains input further.

## Storage and identity

The extension creates one private temporary directory (`0700`) and private
randomly named content files (`0600`). Records contain only opaque refs and safe
metadata. Browser names are control-character stripped, basename-only and run
through shared secret redaction. No source path, raw bytes or content digest is
returned or persisted as WebUI evidence.

Each reference is bound to:

- exact `runtimeInstanceId`, `sessionRef` and project identity;
- exact `messageRequestId`;
- an expiry;
- one staged file owned by this extension runtime.

Claim is atomic. The bridge reads and verifies the private file, removes the
record and temp file, then calls the current Pi `sendUserMessage` surface. A
failed or ambiguous send is never retried automatically with the same refs.
An attachment dispatch receipt can deduplicate within the current extension
runtime, but is not reconstructed as exact content proof after a bridge rebind:
raw bytes and reusable content hashes are intentionally not persisted. The old
command then fails its revision/ref checks instead of sending again.
Session replacement, runtime shutdown and expiry cleanup can delete only files
created inside the store-owned temporary directory; user source files are never
deleted.

## Delivery

Images become Pi-native image content parts. Text files become bounded text
content parts with the redacted display name and MIME type. The user-entered
chat text remains the first text part. The exact joined text projection is used
for same-session dispatch correlation; image bytes never enter the correlation
or receipt store.

Held queue items do not accept attachments in this iteration. The browser
disables Hold while files are selected and the runtime continues to reject a
forged held-message attachment request.

## Failure behavior

- MIME mismatch, malformed base64/UTF-8/JSON, limit excess, stale identity or
  revision, expired command and unsafe temp storage fail closed.
- An unavailable image-capable model disables image staging; text files remain
  independent of model image support.
- Sidecar or browser restart may lose draft presentation state but cannot create
  a send, leak staged bytes or transfer authority to another session.
- Store cleanup and projection failures never interrupt the Pi terminal loop.

## Acceptance gates

1. Upload/select/remove/preview makes zero provider calls and zero Pi messages.
2. Arbitrary path fields and archive MIME are rejected before any source read.
3. Magic-byte spoof, invalid calendar time, oversized item/message/runtime and
   cross-session/message/expiry replay are rejected.
4. Owner-only mode, symlink/inode replacement and cleanup target boundaries are
   tested.
5. Exact current-session text and image delivery is observed once; duplicate
   stage/send commands do not duplicate model work.
6. Browser flow covers selection, bounded metadata preview, removal, successful
   send and actionable rejection text.
