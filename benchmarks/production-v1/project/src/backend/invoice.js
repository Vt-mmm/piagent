export function invoiceTotalCents(lines, taxBps = 0) {
  const subtotal = lines.reduce((sum, line) => sum + Number(line.unitCents || 0), 0);
  return Math.round(subtotal * (1 + (taxBps / 10_000)));
}
