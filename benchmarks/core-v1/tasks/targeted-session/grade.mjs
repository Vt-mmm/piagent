import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? "");
const checks = [];
try {
  const module = await import(`${pathToFileURL(path.join(workspace, "src", "auth", "session.js")).href}?grade=${Date.now()}`);
  checks.push({ id: "future-valid", passed: module.isSessionValid({ expiresAt: 1001 }, 1000) === true });
  checks.push({ id: "past-expired", passed: module.isSessionValid({ expiresAt: 999 }, 1000) === false });
  checks.push({ id: "equal-expired", passed: module.isSessionValid({ expiresAt: 1000 }, 1000) === false });
} catch (error) {
  checks.push({ id: "module-loads", passed: false, detail: error.message });
}
process.stdout.write(`${JSON.stringify({ passed: checks.every((check) => check.passed), checks })}\n`);
