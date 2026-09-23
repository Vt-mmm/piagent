import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertLoopbackHello, assertSupportedLoopbackTurn } from "./helpers/production-journey-transport.mjs";

test("a schema-valid hello from a different gateway cannot qualify the offline journey", () => {
  const capabilities = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,
    "../evals/fixtures/piagent-webui/gateway-capabilities-v1.valid.json"), "utf8"));
  const hello = { schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "hello", capabilities };
  assert.doesNotThrow(() => assertLoopbackHello(hello, capabilities.gatewayInstanceRef));
  assert.throws(() => assertLoopbackHello(hello, "gateway_other_fixture"), /gateway-identity-mismatch/);
});

test("offline transport rejects uncertain create and unsupported abort before dispatch", () => {
  assert.doesNotThrow(() => assertSupportedLoopbackTurn({ reconnectBefore: true }));
  assert.throws(() => assertSupportedLoopbackTurn({ receiptUncertain: true }), /uncertain-send-requires-existing-session/);
  assert.doesNotThrow(() => assertSupportedLoopbackTurn({ receiptUncertain: true }, "session_existing"));
  for (const abortAfterMs of [0, 1, 5000]) {
    assert.throws(() => assertSupportedLoopbackTurn({ abortAfterMs }), /abort-not-supported/);
  }
});
