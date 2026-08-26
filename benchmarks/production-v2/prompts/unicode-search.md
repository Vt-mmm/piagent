Make search matching robust in `src/frontend/unicode-search.js`.

Matching must be case-insensitive, accent-insensitive for decomposable Unicode
letters, trim outer whitespace, and collapse internal whitespace runs to one
space. It must remain safe for nullish input. Preserve both exports and do not
add dependencies. Run the project verification commands.
