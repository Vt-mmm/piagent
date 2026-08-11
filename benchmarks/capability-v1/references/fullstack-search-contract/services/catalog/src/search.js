import { normalizeQuery } from "../../../packages/shared/src/search-contract.js";

export function searchCatalog(items, query, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("options must be an object");
  const limit = options.limit ?? 20;
  if (!Array.isArray(items) || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError("invalid search input");
  const needle = normalizeQuery(query);
  return items.filter((item) => {
    const tags = Array.isArray(item?.tags) ? item.tags.filter((tag) => typeof tag === "string") : [];
    return normalizeQuery([item?.name, ...tags].join(" ")).includes(needle);
  }).slice(0, limit);
}
