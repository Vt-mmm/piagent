export function invoiceTotal(lines) {
  return lines.reduce((total, line) => total + line.price, 0);
}
