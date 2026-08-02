import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? "");
const checks = [];
try {
  const discount = await import(`${pathToFileURL(path.join(workspace, "src", "discount.js")).href}?grade=${Date.now()}`);
  const order = await import(`${pathToFileURL(path.join(workspace, "src", "order.js")).href}?grade=${Date.now()}`);
  checks.push({ id: "discount-api", passed: typeof discount.discountAmount === "function" });
  checks.push({ id: "order-api", passed: typeof order.orderTotal === "function" });
  checks.push({ id: "percentage-math", passed: discount.discountAmount(250, 20) === 50 });
  checks.push({ id: "order-subtracts-discount", passed: order.orderTotal([{ price: 100, quantity: 2 }, { price: 50, quantity: 1 }], 20) === 200 });
  checks.push({ id: "zero-percent", passed: order.orderTotal([{ price: 7, quantity: 3 }], 0) === 21 });
} catch (error) {
  checks.push({ id: "modules-load", passed: false, detail: error.message });
}
process.stdout.write(`${JSON.stringify({ passed: checks.every((check) => check.passed), checks })}\n`);
