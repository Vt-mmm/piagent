import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? "");
const target = path.join(workspace, "src", "invoice.js");
const checks = [];
try {
  const module = await import(`${pathToFileURL(target).href}?grade=${Date.now()}`);
  checks.push({ id: "keeps-export", passed: typeof module.invoiceTotal === "function" });
  checks.push({ id: "uses-quantity", passed: module.invoiceTotal([{ price: 8, quantity: 3 }, { price: 2, quantity: 4 }]) === 32 });
  checks.push({ id: "empty-invoice", passed: module.invoiceTotal([]) === 0 });
  checks.push({ id: "source-remains-readable", passed: fs.statSync(target).isFile() });
} catch (error) {
  checks.push({ id: "module-loads", passed: false, detail: error.message });
}
process.stdout.write(`${JSON.stringify({ passed: checks.every((check) => check.passed), checks })}\n`);
