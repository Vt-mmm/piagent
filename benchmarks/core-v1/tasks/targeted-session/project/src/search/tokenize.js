export function tokenize(value) {
  return value.toLowerCase().split(/\s+/).filter(Boolean);
}
