import { discountAmount } from "./discount.js";

export function orderTotal(lines, percent) {
  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  return discountAmount(subtotal, percent);
}
