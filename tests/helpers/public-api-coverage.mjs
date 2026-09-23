import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
const rows=JSON.parse(fs.readFileSync(new URL("./public-api-baselines.json",import.meta.url)));
// Reviewed public task-start API declarations, not reference implementation
// answers or a hidden grader. Each opt-in is explicit inside the signed checks.
export function addPublicApiCoverage(contracts){
  for(const contract of contracts){
    const row=rows.find(item=>item.sourcePath===contract.sourcePath);
    assert.equal(row?.status,"observed",`Public API declaration unsupported: ${contract.sourcePath}`);
    const bytes=fs.readFileSync(new URL(`../../benchmarks/production-v3/project/${contract.sourcePath}`,import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"),row.sha256,"Public API baseline changed; review the contract before adoption");
    for(const check of contract.checks)for(const item of check.cases)item.expected.publicApi=structuredClone(row.value);
  }
  return contracts;
}
