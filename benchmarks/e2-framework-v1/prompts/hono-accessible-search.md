Implement the real Hono search page in `apps/web/src/search-app.js`. Keep changes inside the declared source and tests.

- [S1] `normalizeQuery` must stringify non-nullish values, normalize NFD combining marks, trim, collapse Unicode whitespace, and lowercase.
- [S2] `createSearchApp({ items })` returns a Hono app with `GET /search`; match normalized names and string tags in input order without mutation.
- [S3] The optional `limit` query defaults to 20 and accepts safe integers 1 through 100; invalid values return 400 JSON rather than an exception page.
- [S4] Return HTML with a labeled search form and `<ul aria-label="Search results">`; escape `& < > " '` in query, ids, and names.
- [S5] Empty results still render the accessible empty list, and caller arrays/objects remain byte-for-value unchanged.

Run `npm test` when complete.
