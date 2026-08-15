import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderAuthBroker } from "../packages/piagent-webui/gateway/provider-auth-broker.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function runtime(login) {
  let configured = false;
  return {
    getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex", auth: { oauth: {} } },
      { id: "plain", name: "Plain", auth: { apiKey: {} } }],
    hasConfiguredAuth: (providerId) => providerId === "openai-codex" && configured,
    async login(providerId, type, interaction) { await login(providerId, type, interaction); configured = true; }
  };
}

describe("WebUI provider OAuth broker", () => {
  it("projects real OAuth providers and completes a bounded prompt flow without returning credentials", async () => {
    const broker = new ProviderAuthBroker(runtime(async (_providerId, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.example.test/authorize?state=opaque", instructions: "Continue in browser" });
      const account = await interaction.prompt({ type: "select", message: "Choose account", options: [
        { id: "personal", label: "Personal" }, { id: "team", label: "Team" }
      ] });
      assert.equal(account, "team");
    }));
    const catalog = broker.catalog();
    assert.equal(catalog.providers.length, 1);
    assert.equal(catalog.providers[0].name, "OpenAI Codex");
    assert.equal(catalog.providers[0].state, "not-connected");
    const started = broker.start({ action: "provider-auth.start", providerRef: catalog.providers[0].providerRef });
    await tick();
    const pending = broker.read(started.jobRef);
    assert.equal(pending.events[0].type, "auth-url");
    assert.equal(pending.events[0].url, "https://auth.example.test/authorize?state=opaque");
    assert.equal(pending.prompt.type, "select");
    const teamOption = pending.prompt.options.find((option) => option.label === "Team");
    assert.ok(teamOption);
    broker.respond({ action: "provider-auth.respond", jobRef: pending.jobRef, promptRef: pending.prompt.promptRef, value: teamOption.id });
    await tick();
    const settled = broker.read(pending.jobRef);
    assert.equal(settled.state, "completed");
    assert.equal(settled.prompt, null);
    assert.equal("credential" in settled, false);
    assert.equal(broker.catalog().providers[0].state, "connected");
  });

  it("fails closed for secret prompts, unsafe URLs, stale prompts, and unknown providers", async () => {
    const broker = new ProviderAuthBroker(runtime(async (_providerId, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "http://unsafe.example.test/", instructions: "sk-proj-secret-value" });
      await interaction.prompt({ type: "secret", message: "Paste a secret" });
    }));
    const catalog = broker.catalog();
    assert.throws(() => broker.start({ action: "provider-auth.start", providerRef: "provider.unknown" }), /not-found/);
    const started = broker.start({ action: "provider-auth.start", providerRef: catalog.providers[0].providerRef });
    await tick(); await tick();
    const failed = broker.read(started.jobRef);
    assert.equal(failed.state, "failed");
    assert.deepEqual(failed.events, []);
    assert.equal(failed.prompt, null);
    assert.throws(() => broker.respond({ action: "provider-auth.respond", jobRef: failed.jobRef, promptRef: "authprompt.stale", value: "x" }), /stale/);
    assert.doesNotMatch(JSON.stringify(failed), /sk-proj-secret-value/);
  });
});
