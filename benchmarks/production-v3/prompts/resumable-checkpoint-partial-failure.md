Fix `src/reliability/checkpoint.js` while preserving the async function
`resumeWork(items, checkpoint, processItem)`.

`checkpoint` contains `nextIndex` and the successful `results` collected for
indices before it. Resume exactly at `nextIndex`; never process an earlier item
again. After all remaining items succeed, return a new checkpoint with
`nextIndex === items.length` and all results. When `processItem` throws, rethrow
the same error after attaching a new `checkpoint` containing every result that
completed before that failure and the failed index as `nextIndex`.

`checkpoint` must be a non-null, non-array object with integer `nextIndex` in
the inclusive range `0..items.length` and an array `results` satisfying
`results.length === nextIndex`; reject malformed shapes, negative or
out-of-range indices, and results length mismatches with `TypeError`.
Do not mutate inputs. Run the configured verification.
