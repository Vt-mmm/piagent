export function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

export function geometricMean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

export function rounded(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function clamp(value, minimum = 0, maximum = 10) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(successes) || successes < 0 || successes > total) return null;
  const proportion = successes / total;
  const zSquared = z ** 2;
  const denominator = 1 + (zSquared / total);
  const center = (proportion + (zSquared / (2 * total))) / denominator;
  const margin = (z / denominator) * Math.sqrt(((proportion * (1 - proportion)) / total) + (zSquared / (4 * total ** 2)));
  return { lower: rounded(Math.max(0, center - margin), 4), upper: rounded(Math.min(1, center + margin), 4) };
}

const STUDENT_T_975 = Object.freeze([
  null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
  2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093,
  2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042
]);

export function geometricMeanConfidence95(values) {
  if (!Array.isArray(values) || values.length < 2 || values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const logs = values.map(Math.log);
  const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  const variance = logs.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (logs.length - 1);
  const critical = STUDENT_T_975[logs.length - 1] ?? 1.96;
  const margin = critical * Math.sqrt(variance / logs.length);
  return {
    lower: rounded(Math.exp(mean - margin), 4),
    upper: rounded(Math.exp(mean + margin), 4),
    sampleUnit: "scenario-family",
    scenarioCount: logs.length
  };
}
