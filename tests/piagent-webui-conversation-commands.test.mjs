import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationCommands, matchConversationCommand, SHORTCUTS } from "../packages/piagent-webui/client/src/conversation-commands.ts";

// The Terminal's / commands in a dashboard conversation: run through the same
// session commands as the buttons, never sent to the model (/undo excepted).
function context(overrides = {}) {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); };
  const actions = { setModel: record("setModel"), setThinking: record("setThinking"), setFast: record("setFast"), setPermission: record("setPermission"),
    rename: record("rename"), fork: record("fork"), pin: record("pin"), archive: record("archive"), stop: record("stop"),
    newChat: () => calls.push(["newChat"]), openChanges: () => calls.push(["openChanges"]), openSettings: () => calls.push(["openSettings"]) };
  return { calls, value: { locale: "en", company: false, running: false, pinned: false, fast: null, thinkingLevels: ["off", "low", "high"],
    loadModels: async () => [{ modelRef: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" }, { modelRef: "openai/gpt-6-sol", label: "GPT-6 Sol" }],
    ...overrides, actions: { ...actions, ...(overrides.actions ?? {}) } } };
}
const run = async (ctx, text) => { const found = matchConversationCommand(text, conversationCommands(ctx)); assert.ok(found, text); return found.command.run(found.argument); };

test("a / command is the whole message; anything else stays a message", () => {
  const commands = conversationCommands(context().value);
  assert.deepEqual(Object.values(matchConversationCommand("  /name   Release notes  ", commands) ?? {}).slice(1), ["Release notes"]);
  assert.equal(matchConversationCommand("/name", commands)?.argument, "");
  for (const text of ["please /name x", "/unknown", "/Name x", "name x", "/skill:deploy"]) assert.equal(matchConversationCommand(text, commands), null, text);
});

test("company and personal conversations offer their own commands", () => {
  const names = (ctx) => conversationCommands(context(ctx).value).map((command) => command.name);
  const personal = names({}), company = names({ company: true, fast: "off", thinkingLevels: ["low", "medium"] });
  assert.deepEqual(personal, ["help", "new", "stop", "name", "fork", "pin", "archive", "thinking", "model", "permission", "changes", "settings"]);
  assert.deepEqual(company, ["help", "new", "stop", "name", "fork", "pin", "archive", "thinking", "undo", "fast", "bypass", "changes", "settings"]);
  // Fast only where the Harness allows it; no thinking command without levels.
  assert.ok(!names({ company: true, fast: null, thinkingLevels: [] }).some((name) => name === "fast" || name === "thinking"));
});

test("each command runs the session command the button runs, and says what happened", async () => {
  const { calls, value } = context({ running: true, pinned: true });
  assert.deepEqual(await run(value, "/name  Shop fixes "), { tone: "success", text: "Renamed to “Shop fixes”." });
  assert.equal((await run(value, "/name")).tone, "warning", "a missing argument is a usage note, nothing runs");
  assert.equal((await run(value, "/thinking ultra")).tone, "warning");
  await run(value, "/thinking high"); await run(value, "/fork"); await run(value, "/pin"); await run(value, "/archive"); await run(value, "/stop");
  await run(value, "/new"); await run(value, "/changes"); await run(value, "/settings");
  assert.deepEqual(calls, [["rename", "Shop fixes"], ["setThinking", "high"], ["fork"], ["pin", false], ["archive"], ["stop"], ["newChat"], ["openChanges"], ["openSettings"]]);
  // A model is chosen by its name or ref; an ambiguous or unknown name lists them.
  assert.match((await run(value, "/model gpt-6-sol")).text, /The model is now GPT-6 Sol/);
  assert.match((await run(value, "/model claude")).text, /Claude Sonnet 5\.5/);
  assert.match((await run(value, "/model")).text, /^Usage: \/model <name>\. Available: Claude Sonnet 5\.5, GPT-6 Sol/);
  assert.deepEqual(calls.slice(-2), [["setModel", "openai/gpt-6-sol"], ["setModel", "anthropic/claude-sonnet-5-5"]]);
  // Nothing runs to stop.
  assert.match((await run(context().value, "/stop")).text, /No turn is running/);
});

test("full access and Bypass ask first; the rest of access and Fast apply at once; /undo goes to the company runtime", async () => {
  const personal = context();
  const full = await run(personal.value, "/permission full");
  assert.ok("confirm" in full); assert.equal(personal.calls.length, 0, "nothing changes before the member confirms");
  assert.deepEqual(await full.confirm.run(), { tone: "success", text: "Access is now full." });
  await run(personal.value, "/permission read-only");
  assert.deepEqual(personal.calls, [["setPermission", "trusted-full-access"], ["setPermission", "read-only"]]);
  const company = context({ company: true, fast: "off", bypass: true });
  const bypass = await run(company.value, "/bypass on");
  assert.match(bypass.confirm.title, /Turn on Bypass/); await bypass.confirm.run();
  const companyFull = await run(company.value, "/bypass full");
  assert.match(companyFull.confirm.title, /Turn on Full access/); await companyFull.confirm.run();
  await run(company.value, "/bypass off"); await run(company.value, "/fast"); await run(company.value, "/fast off");
  assert.equal((await run(company.value, "/bypass")).tone, "warning");
  assert.deepEqual(company.calls, [["setPermission", "bypass"], ["setPermission", "trusted-full-access"], ["setPermission", "workspace-write"], ["setFast", true], ["setFast", false]]);
  // A Harness with Bypass switched off by the administrator.
  const closed = context({ company: true, fast: null, bypass: false });
  assert.equal((await run(closed.value, "/bypass on")).tone, "warning"); assert.equal(closed.calls.length, 0);
  assert.deepEqual(await run(company.value, "/undo"), { send: true });
});

test("a refused command keeps the conversation as it was and says why; /help lists commands and shortcuts", async () => {
  const busy = context({ actions: { setThinking: async () => { throw new Error("session-runtime-busy"); } } });
  assert.deepEqual(await run(busy.value, "/thinking low"), { tone: "error", text: "Could not change thinking: this turn is running; try again when it ends." });
  const vi = context({ locale: "vi" });
  const help = await run(vi.value, "/help");
  assert.equal(help.tone, "info");
  assert.match(help.text, /^\/help — Danh sách lệnh \/ và phím tắt\n\/new — Cuộc trò chuyện mới/);
  for (const [keys] of SHORTCUTS) assert.ok(help.text.includes(`${keys} — `), keys);
});
