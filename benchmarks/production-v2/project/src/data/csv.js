export function parseCsv(input) {
  return String(input).trimEnd().split("\n").map((line) => line.split(","));
}
