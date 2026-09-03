Correct `src/frontend/pagination.js`.

`pageCount(totalItems, pageSize)` must use exact ceiling division, return zero
for zero items, and throw `TypeError` unless total items is a non-negative
integer and page size is a positive integer. `clampPage` returns zero when no
pages exist; otherwise it clamps an integer page to the inclusive range
`1..pageCount`. Keep the API and verify the project.
