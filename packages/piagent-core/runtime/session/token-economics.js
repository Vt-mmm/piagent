// What a session's token counts mean, in one place.
//
// `fresh` is the benchmark's own definition -- input + output, the tokens billed
// at full rate -- restated here rather than recomputed differently by each
// reader. The published benchmark and the terminal must never mean two things by
// the same word.
//
// The cache hit rate is reported beside `fresh`, never instead of it. In that
// same benchmark the baseline surface held the *higher* hit rate, 84.9% against
// 53.0%, while spending more than twice the fresh tokens: a high rate on a large
// prompt is not a cheap session. The rate explains a cost, it does not report one.

const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function sessionTokenEconomics(tokens = {}) {
  const { input, output, cacheRead } = tokens ?? {};
  const fresh = finite(input) && finite(output) ? input + output : null;
  const prompt = finite(cacheRead) && finite(input) ? cacheRead + input : null;
  return {
    fresh,
    // A session that has read nothing has no rate to report, which is not the
    // same as a rate of zero.
    cacheHitRate: prompt !== null && prompt > 0 ? cacheRead / prompt : null
  };
}

export function formatTokenEconomics(economics, formatNumber, formatPercent) {
  return {
    fresh: economics.fresh === null ? "unknown" : `${formatNumber(economics.fresh)} billed at full rate`,
    cache: economics.cacheHitRate === null
      ? "unknown"
      : `${formatPercent(100 * economics.cacheHitRate)} of prompt tokens served from cache`
  };
}
