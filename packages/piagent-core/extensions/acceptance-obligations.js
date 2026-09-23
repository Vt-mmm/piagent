function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function inferAcceptanceObligations(text, changeMode = "source-change", options = {}) {
  const value = normalizedText(text);
  // A source path locates the change; it does not declare a storage API.
  const storageText = value.replace(/\b(?:[a-z0-9_.@-]+\/)+[a-z0-9_.@/-]+\b/g, " ");
  const accessControlText = storageText.replace(/`[^`\n]*`/g, " ");
  const obligations = [];
  if (changeMode === "read-only" || options.mutationPolicy === "forbidden" || options.readOnlyBoundary === true) {
    obligations.push("read-only-evidence");
  }
  const actorAccessControl = includesAny(accessControlText, [
    /\b(?:admins?|roles?|owners?|users?|callers?|resources?)\b[\s\S]{0,80}\b(?:access|allow(?:ed)?|deny|denied|block(?:ed)?|forbid(?:den)?|manag(?:e|es|ed|ing))\b/,
    /\b(?:access|allow(?:ed)?|deny|denied|block(?:ed)?|forbid(?:den)?|manag(?:e|es|ed|ing))\b[\s\S]{0,80}\b(?:admins?|roles?|owners?|users?|callers?|resources?)\b/
  ]);
  const explicitAuthorization = includesAny(accessControlText, [
    /\bauth(?:orization)?\b/, /\bunauthoriz(?:ed|ation)\b/, /\bpermission\b/
  ]) || actorAccessControl;
  const ownerAccessControl = /\bowner\b/.test(accessControlText) && includesAny(accessControlText, [
    /\busers?\b/, /\bresources?\b/, /\baccess\b/, /\bmanag(?:e|es|ed|ing)\b/, /\bauth(?:orization)?\b/, /\bpermission\b/, /\broles?\b/
  ]);
  if (explicitAuthorization || ownerAccessControl) {
    obligations.push("authorization-deny-case");
  }
  const tenantMentioned = includesAny(value, [/\btenants?\b/, /\bcross[- ]tenant\b/, /\bsame[- ]tenant\b/, /\btenantid\b/]);
  const tenantStorage = tenantMentioned && includesAny(storageText, [
    /\bcache\b/, /\bcache[- ]?key\b/, /\bstorage\b/, /\bcollision\b/, /\bentity\b/, /\bsame tuple\b/
  ]);
  const strongAuthorization = includesAny(accessControlText, [
    /\bauth(?:orization)?\b/, /\bunauthoriz(?:ed|ation)\b/, /\bpermission\b/
  ]);
  const tenantActorAccess = tenantMentioned && actorAccessControl;
  const explicitTenantAccessBoundary = includesAny(value, [
    /\bcross[- ]tenant\b/, /\bsame[- ]tenant\b/, /\btenant boundary\b/,
    /\btenantid\b[\s\S]{0,100}\b(?:equal|match|same non-empty|access|allow|deny|block|forbid)/,
    /\b(?:access|allow|deny|block|forbid)[\s\S]{0,100}\btenantid\b/
  ]) && includesAny(value, [
    /\baccess\b/, /\ballow(?:ed)?\b/, /\b(?:deny|denied)\b/, /\bblock(?:ed)?\b/, /\bforbid(?:den)?\b/,
    /\bequal\b/, /\bmatch(?:es|ed|ing)?\b/, /\bsame non-empty\b/
  ]);
  if (tenantMentioned) {
    if (tenantStorage) {
      obligations.push("tenant-storage-isolation");
    } else if (strongAuthorization || ownerAccessControl || tenantActorAccess || explicitTenantAccessBoundary) {
      obligations.push("tenant-boundary");
    }
  }
  // A quoted return value names an outcome, not an input-rejection rule.
  const inputContractText = value.replace(/\breturn(?:s|ed)?\s+(?:`[^`\n]*`|"[^"\n]*"|'[^'\n]*')/g, "return value");
  const namedNonEmptyString = /(?:`[a-z_$][a-z0-9_$]*`|\b[a-z_$][a-z0-9_$]*)\s+(?:must|should|has\s+to)\s+be\s+(?:an?\s+)?non[- ]empty\s+string\b/.test(inputContractText);
  const explicitInvalidInput = namedNonEmptyString || includesAny(inputContractText, [/\binvalid\b/, /\btypeerror\b/, /\bthrow\b/, /\b(?:(?:must|should|needs? to|has to) be|requires?)\s+(?:an?\s+)?(?:(?:non-negative|positive|safe)\s+)*integers?\b/]);
  const rejectInvalidInput = /\breject(?:s|ed|ion)?\b/.test(inputContractText)
    && !/\breject(?:s|ed|ion)?\s+(?:no\s+)?valid\b/.test(inputContractText)
    && includesAny(inputContractText, [/\binvalid\b/, /\bbad\b/, /\bmalformed\b/, /\bnegative\b/, /\bnull\b/, /\bundefined\b/, /\bnon[- ]?(?:number|numeric)\b/, /\bout[- ]?of[- ]?range\b/]);
  if (explicitInvalidInput || rejectInvalidInput) {
    obligations.push("invalid-input-rejection");
  }
  if (includesAny(value, [/\bboundary\b/, /\bceil(?:ing)?\b/, /\bclamp\b/, /\bmin(?:imum)?\b/, /\bmax(?:imum)?\b/, /\binclusive\b/, /\bzero\b/, /\b0\b/, /\bexpiry\b/, /\bround(?:ing)?\b/, /\bedge\b/, /\bfalsey\b/, /\bfalsy\b/, /\bnullish\b/, /\bdefault(?:s)?\b/, /\bpreserv(?:e|ed|es|ing)\b/])) {
    obligations.push("boundary-case");
  }
  if (includesAny(value, [/\bmutation\b/, /\bunchanged\b/, /\bwithout changing\b/, /\bbackward\b/, /\bapi\b/, /\bexported api\b/, /\bfocused\b/])) {
    obligations.push("backward-compatibility");
  }
  if (changeMode === "source-change") obligations.push("verification-evidence");
  return [...new Set(obligations)];
}

