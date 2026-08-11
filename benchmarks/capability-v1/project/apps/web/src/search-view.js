export function renderSearchResults(results) {
  return results.map((item) => `<li>${item.name}</li>`).join("");
}
