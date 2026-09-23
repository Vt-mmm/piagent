import assert from "node:assert/strict";
import test from "node:test";
import { rpcUiContext } from "../packages/piagent-webui/gateway/rpc-ui-context.ts";
import { GATEWAY_RUNTIME_UI_MARKER } from "../packages/piagent-webui/ownership/gateway-runtime-context.ts";

test("RPC UI retains gateway ownership and callable methods when SDK copies context", async () => {
  const ui = { ...rpcUiContext() };
  assert.equal(ui[GATEWAY_RUNTIME_UI_MARKER], true);
  assert.doesNotThrow(() => ui.notify("session started", "info"));
  assert.doesNotThrow(() => ui.setStatus("permission", "read-only"));
  assert.equal(ui.theme.fg("warning", "message"), "message");
  assert.equal(await ui.editor("Edit"), undefined);
  assert.equal(await ui.custom(() => { throw new Error("No terminal UI allowed"); }), undefined);
  assert.equal(ui.getEditorText(), "");
  assert.equal(ui.getToolsExpanded(), false);
  assert.equal(ui.setTheme("dark").success, false);
  assert.doesNotThrow(() => ui.onTerminalInput(() => {})());
  let confirmed = false;
  void ui.confirm("Permission", "Allow?").then(() => { confirmed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, false, "headless UI must not grant confirmation");
});
