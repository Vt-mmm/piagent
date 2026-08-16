import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTokenEconomics, sessionTokenEconomics } from "../packages/piagent-core/runtime/session/token-economics.js";

const number = (value) => Math.round(Number(value)).toLocaleString("en-US");
const percent = (value) => `${Number(value).toFixed(1)}%`;

describe("session token economics", () => {
  it("uses the benchmark's own definition of a fresh token", () => {
    // input + output, exactly as benchmark-core computes it. Two definitions of
    // the same word across the terminal and the published benchmark would make
    // every comparison between them meaningless.
    assert.equal(sessionTokenEconomics({ input: 6801, output: 913, cacheRead: 7680 }).fresh, 7714);
    assert.equal(sessionTokenEconomics({ input: 0, output: 0, cacheRead: 0 }).fresh, 0);
  });

  it("reports the cache rate as a share of prompt tokens", () => {
    // The published benchmark medians: the baseline surface holds the higher
    // rate while spending more than twice the fresh tokens, which is the reason
    // the rate is never reported on its own.
    const piagent = sessionTokenEconomics({ input: 6801, output: 913, cacheRead: 7680 });
    const baseline = sessionTokenEconomics({ input: 13885, output: 2299, cacheRead: 78208 });
    assert.equal(Math.round(piagent.cacheHitRate * 1000) / 10, 53.0);
    assert.equal(Math.round(baseline.cacheHitRate * 1000) / 10, 84.9);
    assert.ok(baseline.cacheHitRate > piagent.cacheHitRate);
    assert.ok(baseline.fresh > 2 * piagent.fresh);
  });

  it("says unknown rather than zero when there is nothing to divide", () => {
    // A session that has read nothing has no rate, which is not a rate of zero.
    assert.equal(sessionTokenEconomics({ input: 0, output: 5, cacheRead: 0 }).cacheHitRate, null);
    assert.equal(sessionTokenEconomics({}).cacheHitRate, null);
    assert.equal(sessionTokenEconomics({}).fresh, null);
    assert.equal(sessionTokenEconomics({ input: 10 }).fresh, null);
    assert.equal(sessionTokenEconomics(undefined).fresh, null);
  });

  it("formats both figures, and says unknown when it cannot", () => {
    const ready = formatTokenEconomics(sessionTokenEconomics({ input: 6801, output: 913, cacheRead: 7680 }), number, percent);
    assert.match(ready.fresh, /^7,714 billed at full rate$/);
    assert.match(ready.cache, /^53\.0% of prompt tokens served from cache$/);
    const empty = formatTokenEconomics(sessionTokenEconomics({}), number, percent);
    assert.equal(empty.fresh, "unknown");
    assert.equal(empty.cache, "unknown");
  });
});
