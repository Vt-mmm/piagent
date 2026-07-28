import fs from "node:fs";
import path from "node:path";

// A project profile can either state its whole policy or name the adapter it
// takes that policy from.
//
// Stating the whole policy freezes it. The adapters ship with the platform and
// are corrected by it, but a project that copied one at onboarding time keeps
// the copy forever, so a global update leaves every existing project on the old
// rules. `extends` makes the policy a reference instead: the project keeps the
// parts that are about the project, and the installed platform supplies the
// rest.
//
// Profiles written before this existed carry no `extends` and keep working
// exactly as they did, self-contained.

const ADAPTER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class ProjectProfileError extends Error {}

export function adapterProfileFile(platformRoot, name) {
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  // The name indexes a directory inside the installed platform, so it is
  // restricted to a plain slug rather than sanitised after the fact.
  if (!ADAPTER_NAME.test(trimmed)) return undefined;
  const candidate = path.join(platformRoot, "adapters", trimmed, "profile.json");
  return fs.existsSync(candidate) ? candidate : undefined;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Resolve a stored project profile document against the installed adapters.
 * Returns the document to enforce, plus the adapter it came from when one was
 * named. Any key the project states replaces the adapter's key whole — there is
 * no per-entry merging of lists, because a half-merged protectedPaths is harder
 * to reason about than a stated one.
 */
export function resolveProjectProfileDocument(platformRoot, stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { profile: stored, base: undefined };
  }
  if (stored.extends === undefined) return { profile: stored, base: undefined };

  const file = adapterProfileFile(platformRoot, stored.extends);
  if (!file) {
    throw new ProjectProfileError(
      `project profile extends "${String(stored.extends)}", which is not an adapter in the installed platform`
    );
  }
  const adapter = readJson(file);
  if (!adapter) throw new ProjectProfileError(`adapter profile is unreadable: ${file}`);

  const { extends: base, ...overrides } = stored;
  return { profile: { ...adapter, ...overrides }, base };
}

export function readProjectProfileDocument(platformRoot, profilePath) {
  const stored = readJson(profilePath);
  if (stored === undefined) return { stored: undefined, profile: undefined, base: undefined };
  const { profile, base } = resolveProjectProfileDocument(platformRoot, stored);
  return { stored, profile, base };
}

/**
 * The document a project stores when it takes its policy from an adapter: what
 * identifies this project, and nothing the platform already knows.
 */
export function buildExtendingProfile(base, projectId, displayName) {
  return {
    schemaVersion: 1,
    extends: base,
    projectId,
    displayName
  };
}
