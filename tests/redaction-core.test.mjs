import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  redactForStorage,
  redactSensitiveText
} from "../packages/piagent-core/extensions/redaction-core.js";

describe("sensitive text redaction", () => {
  const joined = (...parts) => parts.join("");
  const dashJoined = (...parts) => parts.join("-");
  const underscoreJoined = (...parts) => parts.join("_");
  const leakedSecrets = [
    ["AWS secret access key", joined("AWS_SECRET_ACCESS_KEY=", "wJalrXUtnFEMI/", "K7MDENG/bPxRfiCYEXAMPLEKEY")],
    ["AWS secret access key with whitespace separator", joined("aws_secret_access_key ", "wJalrXUtnFEMI/", "K7MDENG/bPxRfiCYEXAMPLEKEY")],
    ["Postgres connection string", "postgres://app:supersecretpass@db.example.com:5432/prod"],
    ["GitHub fine-grained PAT", joined("github_pat_", "11AAAAAAA0", "abcdefghijklmnopqrstuvwxyz")],
    ["Stripe live key", underscoreJoined("sk", "live", "51NxTExampleSecretValue123456")],
    ["Slack bot token", dashJoined("xoxb", "123456789012", "123456789012", "AbCdEfGhIjKlMnOp")],
    ["database password", joined("DATABASE", "_PASSWORD", "=", "CorrectHorse42")],
    ["Google API key", joined("AIza", "SyDExampleKeyWithEnoughLength123456")],
    ["JSON api_key", `{"api_key":"${joined("AIza", "SyDExampleKeyWithEnoughLength123456")}"}`],
    ["Bearer token", joined("Authorization: Bearer ", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".payloadSignature123")],
    ["JWT token", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456"],
    ["OpenAI style key", dashJoined("sk", "abcdefghijklmnopqrstuvwxyz1234567890")],
    ["PEM block", joined("-----BEGIN ", "PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----")]
  ];

  for (const [name, text] of leakedSecrets) {
    it(`redacts ${name}`, () => {
      const result = redactSensitiveText(text);
      assert.equal(result.redacted, true);
      assert.match(result.text, /\[REDACTED_SECRET\]/);
      for (const fragment of [
        "CorrectHorse42",
        "supersecretpass",
        joined("github", "_pat_"),
        underscoreJoined("sk", "live", ""),
        dashJoined("xoxb", ""),
        joined("AI", "za"),
        "eyJhbGci",
        "abcdefghijklmnopqrstuvwxyz1234567890",
        "PRIVATE KEY"
      ]) {
        assert.equal(result.text.includes(fragment), false, `${name} leaked ${fragment}`);
      }
    });
  }

  const benignTexts = [
    "The secret: always run tests before final.",
    "token: null",
    "if (token === undefined) return;",
    "api_key: placeholder",
    "password: short",
    "password: <not-set>",
    "Set api_key = your-key-here in the config"
  ];

  for (const text of benignTexts) {
    it(`does not redact benign prose: ${text}`, () => {
      const result = redactSensitiveText(text);
      assert.equal(result.redacted, false);
      assert.equal(result.text, text);
    });
  }

  // A short value under one of these keys used to be kept in the clear, so a
  // command like these went into the evidence ledger verbatim. Under an `=` the
  // syntax is not ambiguous and the length says nothing about whether it is a
  // secret; the prose cases above cover the `:` side of the same rule.
  const shortSecretAssignments = [
    joined("TOKEN", "=", "hunter2", " npm test"),
    joined("PASSWORD", "=", "short7", " npm test"),
    joined("API", "_KEY", "=", "abc", " npm test"),
    joined("DATABASE", "_PASSWORD", "=", "pw1", " npm test")
  ];

  for (const text of shortSecretAssignments) {
    it(`redacts a short value assigned with =: ${text}`, () => {
      const result = redactSensitiveText(text);
      assert.equal(result.redacted, true);
      assert.match(result.text, /\[REDACTED_SECRET\]/);
      assert.equal(result.text.includes("hunter2") || result.text.includes("short7")
        || result.text.includes("=abc") || result.text.includes("pw1"), false);
    });
  }

  // Name-based exclusions do the work that length was mistakenly credited with:
  // these read as configuration whatever their value is.
  it("keeps values whose key only resembles a secret name", () => {
    for (const text of ["passwordPolicy=minimum-length", "semanticTokenType=namespace-declaration", "NODE_ENV=production"]) {
      assert.equal(redactSensitiveText(text).redacted, false, text);
    }
  });

  // Most CLIs take a credential as an option, and the assignment patterns require
  // a key starting with a letter, so every one of these walked straight past them
  // — into the ledger in the clear, and past the gate that refuses secret-bearing
  // commands as evidence.
  const cliOptionSecrets = [
    joined("tool --", "token", "=", "abc123"),
    joined("tool --", "token", " ", "abc123"),
    joined("tool --", "password", "=", "short7"),
    joined("tool --", "password", " ", "short7"),
    joined("tool --", "api-key", "=", "abc123"),
    joined("tool --", "client-secret", "=", "abc123"),
    joined("tool --", "credential", "=", "abc123"),
    joined("tool --", "auth-token", "=", "abc123"),
    joined("tool --", "token", ' "', "abc123", '"'),
    joined("tool --", "token", " '", "abc123", "'")
  ];

  for (const text of cliOptionSecrets) {
    it(`redacts a credential passed as a command-line option: ${text}`, () => {
      const result = redactSensitiveText(text);
      assert.equal(result.redacted, true);
      assert.match(result.text, /\[REDACTED_SECRET\]/);
      assert.equal(result.text.includes("abc123") || result.text.includes("short7"), false);
    });
  }

  // An option with no argument, or followed by the next option, has no value to
  // redact — and a flag name that merely contains a secret word is not one.
  it("keeps command-line options that carry no credential", () => {
    for (const text of [
      "tool --token",
      "tool --token --verbose",
      "git commit --amend --no-verify",
      "npm run verify -- --reporter dot",
      "docker build --no-cache --tag app:latest ."
    ]) {
      assert.equal(redactSensitiveText(text).redacted, false, text);
    }
  });

  // The header value used to run to the end of the line, so the same credential
  // survived or not depending on how much text happened to follow it.
  it("redacts an Authorization header wherever it sits among the arguments", () => {
    const trailing = redactSensitiveText('curl https://x.test -H "Authorization: Token abc123"');
    const leading = redactSensitiveText('curl -H "Authorization: Token abc123" https://x.test');
    for (const result of [trailing, leading]) {
      assert.equal(result.redacted, true);
      assert.match(result.text, /Authorization: Token \[REDACTED_SECRET\]/);
      assert.equal(result.text.includes("abc123"), false);
    }
    assert.equal(redactSensitiveText("Authorization: not required for local runs").redacted, false);
  });

  it("recursively redacts storage payloads", () => {
    const result = redactForStorage({
      summary: joined("DATABASE", "_PASSWORD", "=", "CorrectHorse42"),
      nested: ["token: null", joined("github_pat_", "11AAAAAAA0", "abcdefghijklmnopqrstuvwxyz")],
      credentials: {
        password: "CorrectHorse42",
        token: "placeholder"
      },
      id: "Hf8_3nQvZ0sL1aYp7Tt9mK2rW4xC6bD8",
      checksum: "9f86d081884c7d659a2feaa0c55ad015"
    });
    assert.deepEqual(result, {
      summary: joined("DATABASE", "_PASSWORD", "= [REDACTED_SECRET]"),
      nested: ["token: null", "[REDACTED_SECRET]"],
      credentials: {
        password: "[REDACTED_SECRET]",
        token: "placeholder"
      },
      id: "Hf8_3nQvZ0sL1aYp7Tt9mK2rW4xC6bD8",
      checksum: "9f86d081884c7d659a2feaa0c55ad015"
    });
  });

  it("redacts contextual credentials without treating every opaque identifier as a secret", () => {
    const input = [
      "X-Api-Key: synthetic-header-key-123",
      "clientSecret=synthetic-client-secret-123",
      "https://robot:synthetic-http-pass-42@example.invalid/api",
      "Authorization: Basic dXNlcjpzeW50aGV0aWMtcGFzcy00Mg=="
    ].join("\n");
    const result = redactSensitiveText(input);
    assert.equal(result.redacted, true);
    assert.equal(result.text.includes("synthetic-header-key-123"), false);
    assert.equal(result.text.includes("synthetic-client-secret-123"), false);
    assert.equal(result.text.includes("synthetic-http-pass-42"), false);
    assert.equal(result.text.includes("dXNlcjpzeW50aGV0aWMtcGFzcy00Mg=="), false);
  });

  it("handles quoted values, authorization schemes, and plural structured keys", () => {
    const quoted = redactSensitiveText('password="Correct Horse Battery 42"');
    assert.equal(quoted.text, 'password= "[REDACTED_SECRET]"');
    assert.equal(redactSensitiveText(quoted.text).text, quoted.text);
    const escapedQuoted = redactSensitiveText('password="Correct \\"Horse\\" Battery 42"');
    assert.equal(escapedQuoted.text, 'password= "[REDACTED_SECRET]"');

    const authorization = redactSensitiveText("Authorization: Token synthetic-auth-token-123");
    assert.equal(authorization.text, "Authorization: Token [REDACTED_SECRET]");

    const structured = redactForStorage({
      tokens: ["synthetic-array-token-123"],
      apiKeys: ["synthetic-array-key-123"],
      passwords: ["hunter42"],
      credentials: ["userpass"],
      semanticTokens: ["namespace-declaration-123"],
      colorTokens: ["primary-blue-500"],
      passwordPolicy: "minimum-length",
      semanticTokenType: "namespace-declaration"
    });
    assert.deepEqual(structured, {
      tokens: ["[REDACTED_SECRET]"],
      apiKeys: ["[REDACTED_SECRET]"],
      passwords: ["[REDACTED_SECRET]"],
      credentials: ["[REDACTED_SECRET]"],
      semanticTokens: ["namespace-declaration-123"],
      colorTokens: ["primary-blue-500"],
      passwordPolicy: "minimum-length",
      semanticTokenType: "namespace-declaration"
    });
    assert.equal(redactSensitiveText("passwordPolicy=minimum-length").redacted, false);
    assert.equal(redactSensitiveText("semanticTokenType=namespace-declaration").redacted, false);
  });
});
