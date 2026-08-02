export function pageCount(totalItems, pageSize) {
  if (totalItems <= 0) return 0;
  return Math.floor(totalItems / pageSize) + 1;
}

export function clampPage(page, totalItems, pageSize) {
  return Math.max(1, Math.min(page, pageCount(totalItems, pageSize)));
}
