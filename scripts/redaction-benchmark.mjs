#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  redactForStorage,
  redactSensitiveText
} from "../packages/piagent-core/security/sensitive-data.js";

const REDACTION = "[REDACTED_SECRET]";
const join = (...parts) => parts.join("");

const contextualCases = [
  ["aws-assignment", "assignment", join("AWS_SECRET_ACCESS_KEY=", "wJalrXUtnFEMI/", "K7MDENG/bPxRfiCYEXAMPLEKEY")],
  ["aws-whitespace", "assignment", join("aws_secret_access_key ", "wJalrXUtnFEMI/", "K7MDENG/bPxRfiCYEXAMPLEKEY")],
  ["github-fine", "vendor", join("github_pat_", "11AAAAAAA0", "abcdefghijklmnopqrstuvwxyz")],
  ["github-classic", "vendor", join("ghp_", "abcdefghijklmnopqrstuvwxyz1234567890")],
  ["openai-project", "vendor", join("sk-", "proj-", "abcdefghijklmnopqrstuvwxyz1234567890")],
  ["stripe-live", "vendor", join("sk_", "live_", "51NxTExampleSecretValue123456")],
  ["slack-bot", "vendor", join("xoxb-", "123456789012-123456789012-", "AbCdEfGhIjKlMnOp")],
  ["google-api", "vendor", join("AIza", "SyDExampleKeyWithEnoughLength123456")],
  ["jwt", "vendor", join("eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "signature123456")],
  ["pem-pkcs8", "private-key", join("-----BEGIN ", "PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----")],
  ["pem-openssh", "private-key", join("-----BEGIN ", "OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----")],
  ["postgres-url", "credential-url", "postgres://app:synthetic-pass-42@db.example.invalid/prod"],
  ["mysql-url", "credential-url", "mysql://app:synthetic-pass-42@db.example.invalid/prod"],
  ["mariadb-url", "credential-url", "mariadb://app:synthetic-pass-42@db.example.invalid/prod"],
  ["mongodb-url", "credential-url", "mongodb://app:synthetic-pass-42@db.example.invalid/prod"],
  ["redis-url", "credential-url", "redis://app:synthetic-pass-42@cache.example.invalid/0"],
  ["http-userinfo", "credential-url", "https://robot:synthetic-http-pass-42@example.invalid/api"],
  ["ftp-userinfo", "credential-url", "ftp://robot:synthetic-ftp-pass-42@example.invalid/archive"],
  ["bearer", "authorization", "Authorization: Bearer syntheticBearerToken_1234567890"],
  ["basic-auth", "authorization", "Authorization: Basic dXNlcjpzeW50aGV0aWMtcGFzcy00Mg=="],
  ["token-auth", "authorization", "Authorization: Token synthetic-auth-token-123"],
  ["api-key-auth", "authorization", "Authorization: ApiKey synthetic-auth-key-123"],
  ["digest-auth", "authorization", "Authorization: Digest username=robot, response=synthetic-response-123"],
  ["password-key", "assignment", "PASSWORD=synthetic-pass-42"],
  ["pwd-key", "assignment", "pwd: synthetic-pass-42"],
  ["api-key-json", "assignment", "{\"api_key\":\"synthetic-key-123456\"}"],
  ["client-secret", "assignment", "client_secret=synthetic-client-123"],
  ["access-token", "assignment", "access_token=synthetic-access-123"],
  ["refresh-token", "assignment", "refresh_token=synthetic-refresh-123"],
  ["credential-key", "assignment", "credential: synthetic-credential-123"],
  ["prefixed-token", "assignment", "CI_JOB_TOKEN=synthetic-job-token-123"],
  ["alphabetic-token", "assignment", "token=abcdefghijklmnopqrstuvwx"],
  ["alphabetic-api-key", "assignment", "apiKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
  ["alphabetic-authorization", "authorization", "Authorization: Token abcdefghijklmnopqrstuvwx"],
  ["webhook-secret", "assignment", "WEBHOOK_SECRET=synthetic-webhook-123"],
  ["session-token", "assignment", "session_token=synthetic-session-123"],
  ["query-token", "assignment", "https://example.invalid/callback?access_token=synthetic-query-token-123"],
  ["query-refresh-token", "assignment", "https://example.invalid/callback?refresh_token=synthetic-query-refresh-123&ok=1"],
  ["hyphen-header", "assignment", "X-Api-Key: synthetic-header-key-123"],
  ["private-token-header", "assignment", "PRIVATE-TOKEN: synthetic-private-token-123"],
  ["camel-api-key", "assignment", "{\"apiKey\":\"synthetic-camel-key-123\"}"],
  ["camel-client-secret", "assignment", "{\"clientSecret\":\"synthetic-camel-secret-123\"}"],
  ["camel-access-token", "assignment", "{\"accessToken\":\"synthetic-camel-access-123\"}"],
  ["passphrase", "assignment", "passphrase=synthetic-passphrase-123"],
  ["private-key-field", "assignment", "{\"private_key\":\"synthetic-private-material-123\"}"],
  ["signing-key-field", "assignment", "signingKey=synthetic-signing-material-123"],
  ["quoted-export", "assignment", "export TOKEN='synthetic-export-token-123'"],
  ["quoted-password-spaces", "assignment", "password=\"Correct Horse Battery 42\""],
  ["quoted-client-secret-spaces", "assignment", "clientSecret='synthetic client secret 123'"],
  ["quoted-password-escape", "assignment", "password=\"Correct \\\"Horse\\\" Battery 42\""],
  ["quoted-secret-escape", "assignment", "secret='synthetic \\'quoted\\' secret 123'"],
  ["multiline", "assignment", "name=service\npassword=synthetic-multiline-42\nstatus=ok"]
].map(([name, category, text]) => ({ name, category, text }));

const unlabeledEntropyCases = [
  ["base64-32", "QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4"],
  ["urlsafe-40", "Hf8_3nQvZ0sL1aYp7Tt9mK2rW4xC6bD8eF0gJ5hN"],
  ["mixed-48", "aB9xP2mN7qR4tV8zK1cD6fG0hJ3lS5wY9uE2iO7p"],
  ["hex-64", "9f86d081884c7d659a2feaa0c55ad015bf4f1b2b0b822cd15d6c15b0f00a08aa"],
  ["base32-52", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSQ"],
  ["opaque-id", "01J4Z3N8K2Q7V5X9C1B6M0R4T8Y2W7S5"]
].map(([name, text]) => ({ name, text }));

const benignCases = [
  ["prose-secret", "The secret: always run tests before final."],
  ["null-token", "token: null"],
  ["placeholder", "api_key: placeholder"],
  ["short-password", "password: short"],
  ["unset-secret", "clientSecret=<not-set>"],
  ["source-code", "if (token === undefined) return;"],
  ["git-sha", "commit 4431c9edaf7c72b56943d0c74c17ee0214690eb5"],
  ["sha256", "sha256:d8a46b50ea37b68544add1e73ccb382b9ba06f6fe673dd82c50b294fdf412ec6"],
  ["uuid", "request_id=123e4567-e89b-12d3-a456-426614174000"],
  ["example-url", "https://example.invalid/docs"],
  ["package-integrity", "integrity sha512-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=="],
  ["public-key", "-----BEGIN PUBLIC KEY-----\nabc123\n-----END PUBLIC KEY-----"],
  ["artifact-id", "artifact_id=Hf8_3nQvZ0sL1aYp7Tt9mK2rW4xC6bD8"],
  ["trace-id", "trace_id=aB9xP2mN7qR4tV8zK1cD6fG0hJ3lS5wY9uE2"],
  ["checksum", "checksum=9f86d081884c7d659a2feaa0c55ad015"],
  ["model-id", "model=provider-model-2026-07-21"],
  ["file-name", "generated file auth.json.example"],
  ["command-doc", "Run npm test and tsc --noEmit."],
  ["boolean-secret", "secret=false"],
  ["redacted-marker", "password=[REDACTED_SECRET]"],
  ["quoted-redacted-marker", "password=\"[REDACTED_SECRET]\""],
  ["authorization-placeholder", "Authorization: Token placeholder"],
  ["quoted-placeholder", "clientSecret='not-set'"],
  ["your-key", "Set apiKey=your-key-here before local testing."],
  ["ordinary-number", "retry_token_count=12"],
  ["semantic-token-name", "The parser emits a token node."],
  ["password-policy", "Password policy requires twelve characters."],
  ["credential-doc", "Credential rotation is required quarterly."],
  ["password-policy-field", "passwordPolicy=minimum-length"],
  ["semantic-token-type-field", "semanticTokenType=namespace-declaration"]
].map(([name, text]) => ({ name, text }));

const structuredInput = {
  password: "synthetic-structured-pass-42",
  apiKey: "synthetic-structured-key-42",
  nested: {
    clientSecret: "synthetic-structured-client-42",
    sessionToken: "synthetic-structured-session-42"
  },
  tokens: ["synthetic-array-token-123"],
  apiKeys: ["synthetic-array-key-123"],
  passwords: ["hunter42"],
  credentials: ["userpass"],
  id: "Hf8_3nQvZ0sL1aYp7Tt9mK2rW4xC6bD8",
  checksum: "9f86d081884c7d659a2feaa0c55ad015",
  labels: ["provider-model-2026-07-21"],
  semanticTokens: ["namespace-declaration-123"],
  colorTokens: ["primary-blue-500"],
  passwordPolicy: "minimum-length",
  semanticTokenType: "namespace-declaration"
};

function percentage(value, total) {
  return total === 0 ? 1 : value / total;
}

export function evaluateRedactionBenchmark(options = {}) {
  const contextualMisses = contextualCases
    .filter(({ text }) => !redactSensitiveText(text).redacted)
    .map(({ name }) => name);
  const entropyDetected = unlabeledEntropyCases
    .filter(({ text }) => redactSensitiveText(text).redacted)
    .map(({ name }) => name);
  const falsePositives = benignCases
    .filter(({ text }) => redactSensitiveText(text).redacted)
    .map(({ name }) => name);
  const safeStructured = redactForStorage(structuredInput);
  const structuredSensitiveChecks = [
    safeStructured.password === REDACTION,
    safeStructured.apiKey === REDACTION,
    safeStructured.nested?.clientSecret === REDACTION,
    safeStructured.nested?.sessionToken === REDACTION,
    safeStructured.tokens?.[0] === REDACTION,
    safeStructured.apiKeys?.[0] === REDACTION,
    safeStructured.passwords?.[0] === REDACTION,
    safeStructured.credentials?.[0] === REDACTION
  ];
  const structuredBenignChecks = [
    safeStructured.id === structuredInput.id,
    safeStructured.checksum === structuredInput.checksum,
    safeStructured.labels?.[0] === structuredInput.labels[0],
    safeStructured.semanticTokens?.[0] === structuredInput.semanticTokens[0],
    safeStructured.colorTokens?.[0] === structuredInput.colorTokens[0],
    safeStructured.passwordPolicy === structuredInput.passwordPolicy,
    safeStructured.semanticTokenType === structuredInput.semanticTokenType
  ];

  const iterations = Math.max(1, Math.min(Number(options.iterations ?? 250), 10_000));
  const workload = [...contextualCases, ...unlabeledEntropyCases, ...benignCases];
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const { text } of workload) redactSensitiveText(text);
  }
  const durationMs = performance.now() - started;
  const evaluations = iterations * workload.length;
  const largeOutput = `${"ordinary build output\n".repeat(8_192)}X-Api-Key: synthetic-large-output-key-123`;
  const largeStarted = performance.now();
  const largeResult = redactSensitiveText(largeOutput);
  const largeDurationMs = performance.now() - largeStarted;

  const result = {
    contextual: {
      total: contextualCases.length,
      detected: contextualCases.length - contextualMisses.length,
      recall: percentage(contextualCases.length - contextualMisses.length, contextualCases.length),
      missed: contextualMisses
    },
    unlabeledEntropy: {
      total: unlabeledEntropyCases.length,
      detected: entropyDetected.length,
      observationalRecall: percentage(entropyDetected.length, unlabeledEntropyCases.length),
      detectedCases: entropyDetected,
      gated: false
    },
    benign: {
      total: benignCases.length,
      falsePositives: falsePositives.length,
      falsePositiveRate: percentage(falsePositives.length, benignCases.length),
      cases: falsePositives
    },
    structured: {
      sensitiveTotal: structuredSensitiveChecks.length,
      sensitiveRedacted: structuredSensitiveChecks.filter(Boolean).length,
      benignTotal: structuredBenignChecks.length,
      benignPreserved: structuredBenignChecks.filter(Boolean).length
    },
    performance: {
      iterations,
      evaluations,
      durationMs: Number(durationMs.toFixed(3)),
      averageMicroseconds: Number(((durationMs * 1000) / evaluations).toFixed(3))
    },
    largeOutput: {
      bytes: Buffer.byteLength(largeOutput),
      durationMs: Number(largeDurationMs.toFixed(3)),
      sensitiveValueRedacted: largeResult.redacted && !largeResult.text.includes("synthetic-large-output-key-123")
    }
  };
  result.ok = result.contextual.recall === 1
    && result.benign.falsePositives === 0
    && result.structured.sensitiveRedacted === result.structured.sensitiveTotal
    && result.structured.benignPreserved === result.structured.benignTotal
    && result.largeOutput.sensitiveValueRedacted;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = evaluateRedactionBenchmark();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
