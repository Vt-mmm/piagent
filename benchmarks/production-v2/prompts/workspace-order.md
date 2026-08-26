Fix dependency ordering in `src/platform/workspace.js`.

Return every workspace package exactly once with each in-repository dependency
before its dependent. Ignore dependency names not present in the package list.
Preserve input order whenever no dependency edge requires a different order.
Throw an `Error` containing `cycle` when an in-repository cycle exists. Do not
mutate input. Run project verification.
