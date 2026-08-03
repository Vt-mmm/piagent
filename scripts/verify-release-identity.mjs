#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  } catch (error) {
    fail(`${relative} is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function filesUnder(relativeDirectory, extension) {
  const directory = path.join(root, relativeDirectory);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(relative, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(relative);
  }
  return files;
}

function parseArguments(values) {
  const parsed = { tag: "", commit: "" };
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === "-h" || option === "--help") {
      process.stdout.write("Usage: node scripts/verify-release-identity.mjs [--tag vX.Y.Z --commit <40-char-sha>]\n");
      process.exit(0);
    }
    if (option !== "--tag" && option !== "--commit") fail(`unknown option ${option}`);
    const key = option.slice(2);
    if (parsed[key]) fail(`duplicate option ${option}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) fail(`${option} requires a value`);
    parsed[key] = value;
    index += 1;
  }
  if (Boolean(parsed.tag) !== Boolean(parsed.commit)) fail("--tag and --commit must be provided together");
  return parsed;
}

const options = parseArguments(process.argv.slice(2));
const rootPackage = readJson("package.json");
const corePackage = readJson("packages/piagent-core/package.json");
const packageLock = readJson("package-lock.json");
const capabilityLock = readJson(".pi/piagent-profile.lock.json");
const version = rootPackage.version;
const expectedTag = `v${version}`;

// The package is published now, so the old private-forever rule is gone. What
// still has to hold is that a scoped package cannot reach the registry as
// restricted by accident, and cannot ship without provenance.
if (rootPackage.name !== "@piagent/platform") fail("root package must be named @piagent/platform");
if (rootPackage.private) fail("root package must not be private; publishing is intended");
if (rootPackage.publishConfig?.access !== "public") fail("scoped package must declare publishConfig.access=public");
if (rootPackage.publishConfig?.provenance !== true) fail("root package must publish with provenance");
// The git+ prefix is npm's own normalization. Publishing without it succeeds
// but rewrites the field, which leaves the manifest in the repository saying
// something different from the manifest on the registry.
if (rootPackage.repository?.url !== "git+https://github.com/Vt-mmm/piagent.git") fail("root package repository URL is not canonical");
if (corePackage.repository?.url !== rootPackage.repository.url) fail("core package repository URL does not match the root package");
if (rootPackage.dependencies && Object.keys(rootPackage.dependencies).length > 0) fail("root package has unexpected runtime dependencies");
if (packageLock.name !== rootPackage.name || packageLock.packages?.[""]?.name !== rootPackage.name) fail("package-lock root identity does not match package.json");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) fail("package.json version is not a supported release version");
if (corePackage.version !== version) fail("root and core package versions do not match");
if (packageLock.packages?.[""]?.version !== version) fail("package-lock root version does not match package.json");
if (packageLock.packages?.["packages/piagent-core"]?.version !== version) fail("package-lock core version does not match package.json");
if (capabilityLock.core?.packageVersion !== version) fail("capability lock packageVersion does not match package.json");

const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## ${expectedTag} -`)) fail(`CHANGELOG.md has no ${expectedTag} release section`);

// The badge is generated onto every page, so a stale build shows up as one page
// still carrying the previous version rather than as a single missed edit.
const docsPages = filesUnder("docs-site", ".html").filter((name) => !name.startsWith("docs-site/content/"));
if (docsPages.length === 0) fail("docs-site has no generated pages");
for (const page of docsPages) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  if (!html.includes(`${expectedTag} docs`)) fail(`${page} version badge does not identify ${expectedTag}`);
}

// A version written into an install command does not come from the build, so it
// goes stale silently and keeps telling readers to install the previous release.
// The badge check above cannot see these: they are sentences, not generated
// markup.
//
// Only the command shapes are matched, not every version-looking string. Prose
// naming an old release is usually saying something true about history — when a
// behaviour arrived, which release a mistake shipped in — and rewriting those to
// the current number would make them false. Files that exist to list past
// versions are exempt outright.
const VERSION_HISTORY_FILES = new Set(["CHANGELOG.md", "docs/publishing-for-teams.md"]);
const RELEASE_TAG_MENTION = /(?:@piagent\/platform@|Vt-mmm\/piagent@v?|--version )(\d+\.\d+\.\d+)/g;

function proseFiles() {
  const files = fs.readdirSync(path.join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`);
  files.push("README.md");
  files.push(...filesUnder("docs-site/content", ".html"));
  return files.filter((file) => !VERSION_HISTORY_FILES.has(file));
}

for (const file of proseFiles()) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const [mention, named] of text.matchAll(RELEASE_TAG_MENTION)) {
    if (named !== version) fail(`${file} tells the reader to install ${named} (${mention.trim()}), but this release is ${version}`);
  }
}

if (options.tag) {
  if (options.tag !== expectedTag) fail(`release tag ${options.tag} does not match package version ${expectedTag}`);
  if (!/^[0-9a-fA-F]{40}$/.test(options.commit)) fail("--commit must be a 40-character commit SHA");
  let head;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    fail(`could not resolve the checked-out commit: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (head.toLowerCase() !== options.commit.toLowerCase()) fail("checked-out commit does not match the release commit");
}

process.stdout.write(`PASS: release identity ${expectedTag}${options.commit ? ` @ ${options.commit.toLowerCase()}` : ""}\n`);
