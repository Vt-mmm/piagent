Implement one search contract in `packages/shared/src/search-contract.js`,
`services/catalog/src/search.js`, and `apps/web/src/search-view.js`.

- [S1] `normalizeQuery(value)` stringifies non-nullish values, applies Unicode
  NFD normalization, removes every Unicode combining mark, trims, collapses
  whitespace, and lowercases. Nullish input becomes an empty string.
- [S2] `searchCatalog(items, query, options)` requires `items` to be an array
  and must not mutate it. Import and use the shared `normalizeQuery` to search
  each normalized name and only tags whose values are strings; ignore all
  non-string tags. Preserve input order and return at most `limit` results. An
  empty normalized query matches every item. Omitted `options` defaults to a
  new empty object; when supplied it must be a non-null, non-array object.
  `limit` defaults to 20 and must be a positive safe integer or throw
  `TypeError`.
- [S3] `renderSearchResults(results)` requires an array and returns exactly one
  `<ul aria-label="Search results">` with one ordered `<li data-id="...">` per
  result. Escape both ids and names for `&`, `<`, `>`, `"`, and `'`. Empty
  results return `<ul aria-label="Search results"></ul>`.

Preserve exports and add focused tests. Change only the declared source/test
scope.
