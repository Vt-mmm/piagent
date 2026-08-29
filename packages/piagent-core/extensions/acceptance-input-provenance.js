function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function inputDerivedNames(callable, seeds = callable.parameters) {
  const derived = new Set(seeds);
  const declarations = [...callable.body.matchAll(/\bconst\s+([a-z_$][a-z0-9_$]*|\{[^}\n]{1,300}\}|\[[^\]\n]{1,300}\])\s*=\s*([^;\n]{1,1000})/gi)];
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const match of declarations) {
      const initializer = match[2];
      if (/\b(?:process|globalthis)\b|\bimport\.meta\b|\bmath\.random\s*\(/.test(initializer)) continue;
      let provenanceNames = [...derived];
      if (/\bdate\.now\s*\(/.test(initializer)) {
        provenanceNames = callable.parameters.filter((parameter, index) => {
          if (!derived.has(parameter)) return false;
          const escaped = escapeRegex(parameter), arity = index + 1;
          return new RegExp(`^arguments\\s*\\.\\s*length\\s*<\\s*${arity}\\s*\\?\\s*date\\s*\\.\\s*now\\s*\\(\\s*\\)\\s*:\\s*${escaped}$`, "i").test(initializer.trim())
            || new RegExp(`^arguments\\s*\\.\\s*length\\s*>=\\s*${arity}\\s*\\?\\s*${escaped}\\s*:\\s*date\\s*\\.\\s*now\\s*\\(\\s*\\)$`, "i").test(initializer.trim());
        });
        if (provenanceNames.length === 0) continue;
      }
      if (!provenanceNames.some((name) => new RegExp(`\\b${escapeRegex(name)}\\b`).test(initializer))) continue;
      const bindings = match[1].startsWith("{")
        ? match[1].slice(1, -1).split(",").map((item) => item.trim().match(/^(?:[a-z_$][a-z0-9_$]*\s*:\s*)?([a-z_$][a-z0-9_$]*)/i)?.[1])
        : match[1].startsWith("[")
          ? (match[1].match(/[a-z_$][a-z0-9_$]*/gi) ?? [])
          : [match[1]];
      for (const binding of bindings.filter(Boolean)) {
        const normalized = binding.toLowerCase();
        if (!derived.has(normalized)) {
          derived.add(normalized);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return [...derived].slice(0, 24);
}
