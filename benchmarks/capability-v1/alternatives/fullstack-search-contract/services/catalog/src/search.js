import { normalizeQuery } from "../../../packages/shared/src/search-contract.js";

export function searchCatalog(items, query, options = {}) {
  if (!Array.isArray(items) || !options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("invalid search arguments");
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("invalid search limit");
  const expected = normalizeQuery(query);
  const matches = [];
  for (const item of items) {
    const fields = [item?.name];
    if (Array.isArray(item?.tags)) {
      for (const tag of item.tags) if (typeof tag === "string") fields.push(tag);
    }
    if (normalizeQuery(fields.join(" ")).includes(expected)) matches.push(item);
    if (matches.length === limit) break;
  }
  return matches;
}
