import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveProjectProfileDocument } from "../capabilities/project-profile.js";

const DEFAULT_CONTEXT_INDEX_PATH = ".pi/context-index.json";
const CONTEXT_ENGINE_STATE_PATTERN = ".pi/piagent-state/**";
const EXCLUDE_POLICY_VERSION = 1;

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePattern(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function readJsonObject(file, label, { optional = false } = {}) {
  if (!fs.existsSync(file)) {
    if (optional) return undefined;
    throw new Error(`${label} is missing at ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object: ${file}`);
  }
  return parsed;
}

export function contextIndexStatePath(profile) {
  const configured = profile?.contextIndex?.path;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_CONTEXT_INDEX_PATH;
}

export function effectiveProtectedPaths(policy = {}, profile = {}) {
  const policyProtectedPaths = stringArray(policy.protectedPaths);
  const baseReadProtectedPaths = Array.isArray(policy.shellProtectedPaths)
    ? stringArray(policy.shellProtectedPaths)
    : policyProtectedPaths;
  const profileProtectedPaths = stringArray(profile.protectedPaths);
  const profileShellProtectedPaths = Array.isArray(profile.shellProtectedPaths)
    ? stringArray(profile.shellProtectedPaths)
    : profileProtectedPaths;
  const readOnlyPaths = stringArray(profile.readOnlyPaths);
  const contextIndexPath = contextIndexStatePath(profile);
  return {
    readProtectedPaths: uniqueStrings([
      ...baseReadProtectedPaths,
      ...profileProtectedPaths,
      contextIndexPath
    ]),
    writeProtectedPaths: uniqueStrings([
      ...policyProtectedPaths,
      ...profileProtectedPaths,
      ...readOnlyPaths,
      contextIndexPath
    ]),
    shellProtectedPaths: uniqueStrings([
      ...baseReadProtectedPaths,
      ...profileShellProtectedPaths,
      ...readOnlyPaths,
      contextIndexPath
    ]),
    readOnlyPaths: uniqueStrings(readOnlyPaths)
  };
}

export function normalizeContextIndexExcludePatterns(patterns) {
  return uniqueStrings(stringArray(patterns).map(normalizePattern)).sort(compareCodePoints);
}

export function contextIndexExcludePatterns(policy, profile) {
  const effective = effectiveProtectedPaths(policy, profile);
  return normalizeContextIndexExcludePatterns([
    ...effective.readProtectedPaths,
    ...effective.writeProtectedPaths,
    ...effective.shellProtectedPaths,
    CONTEXT_ENGINE_STATE_PATTERN
  ]);
}

export function contextIndexExcludeDigest(patterns) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      version: EXCLUDE_POLICY_VERSION,
      patterns: normalizeContextIndexExcludePatterns(patterns)
    }))
    .digest("hex");
}

export function contextIndexExcludePolicyVersion() {
  return EXCLUDE_POLICY_VERSION;
}

export function loadProjectContextIndexPolicy(platformRoot, projectPath, options = {}) {
  const policyPath = path.join(platformRoot, "packages", "piagent-core", "policies", "base-policy.json");
  const policy = readJsonObject(policyPath, "Piagent base policy");
  const explicitProfilePath = typeof options.profilePath === "string" && options.profilePath.trim()
    ? path.resolve(options.profilePath)
    : undefined;
  const profilePath = explicitProfilePath ?? path.join(projectPath, ".pi", "piagent-profile.json");
  const stored = readJsonObject(profilePath, "Piagent project profile", { optional: !explicitProfilePath });
  const profile = stored
    ? resolveProjectProfileDocument(platformRoot, stored).profile
    : {};
  return {
    policy,
    profile,
    profilePath,
    profileSource: explicitProfilePath ? "env" : stored ? "project" : "fallback",
    excludePatterns: contextIndexExcludePatterns(policy, profile)
  };
}
