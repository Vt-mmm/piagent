export function searchCatalog(items, query) {
  return items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
}
