import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { McpAuthBroker } from "../packages/piagent-webui/gateway/mcp-auth-broker.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeAdapter() {
  return {
    loadMcpConfig: () => ({ mcpServers: { demo: { url: "https://mcp.example.test" },
      "demo sk-proj-abcdefghijklmnopqrstuvwxyz": { url: "https://mcp.example.test" },
      desktop: { url: "http://127.0.0.1:3845/mcp" } }, settings: {} }),
    resolveServerUrl: (definition) => definition.url,
    supportsOAuth: () => true,
    createOAuthRuntime: () => ({}),
    shutdownOAuth: async () => undefined,
    getAuthStatus: async () => "not_authenticated",
    getAuthStorageOptions: () => ({}),
    authenticate: async (_name, _url, _definition, options) => {
      options.onAuthorizationUrl("https://auth.example.test/start?state=opaque");
      return "authenticated";
    }
  };
}

describe("WebUI MCP OAuth broker", () => {
  it("uses the installed adapter flow without returning credentials or raw secret-like names", async () => {
    const broker = new McpAuthBroker("/unused", async () => fakeAdapter());
    const started = await broker.start({ sessionRef: "session.one", connectionRef: "mcp.one", cwd: "/project",
      name: "demo sk-proj-abcdefghijklmnopqrstuvwxyz" });
    assert.deepEqual(await broker.describe("/project", "demo"), { oauthSupported: true, authState: "not-connected" });
    assert.equal(started.name.includes("sk-proj"), false);
    assert.equal(started.authorizationUrl, "https://auth.example.test/start?state=opaque");
    await tick();
    const completed = broker.read(started.jobRef);
    assert.equal(completed.state, "completed");
    assert.equal("credential" in completed, false);
    assert.equal("token" in completed, false);
    await broker.close();
  });

  it("never advertises or starts OAuth for a loopback desktop MCP server", async () => {
    const broker = new McpAuthBroker("/unused", async () => fakeAdapter());
    assert.deepEqual(await broker.describe("/project", "desktop"), { oauthSupported: false, authState: "unavailable" });
    await assert.rejects(() => broker.start({ sessionRef: "session.one", connectionRef: "mcp.desktop", cwd: "/project", name: "desktop" }),
      /mcp-oauth-not-supported/);
    await broker.close();
  });

  it("classifies a provider-forbidden dynamic registration without exposing its raw response", async () => {
    const adapter = fakeAdapter();
    adapter.authenticate = async () => {
      const error = new Error("Dynamic Client Registration rejected (HTTP 403): Forbidden");
      error.name = "RegistrationRejectedError";
      error.status = 403;
      throw error;
    };
    const broker = new McpAuthBroker("/unused", async () => adapter);
    const started = await broker.start({ sessionRef: "session.one", connectionRef: "mcp.one", cwd: "/project", name: "demo" });
    await tick();
    const failed = broker.read(started.jobRef);
    assert.equal(failed.state, "failed");
    assert.equal(failed.reasonCode, "mcp-oauth-client-not-approved");
    assert.equal(JSON.stringify(failed).includes("Forbidden"), false);
    await broker.close();
  });
});
