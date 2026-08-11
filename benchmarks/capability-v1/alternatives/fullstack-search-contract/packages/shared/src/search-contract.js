export function normalizeQuery(value) {
  const decomposed = String(value ?? "").normalize("NFD");
  let unmarked = "";
  for (const character of decomposed) {
    if (!/\p{M}/u.test(character)) unmarked += character;
  }
  return unmarked.trim().split(/\s+/u).filter(Boolean).join(" ").toLowerCase();
}
