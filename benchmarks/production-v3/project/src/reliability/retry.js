export async function retry(operation, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 10;
  const sleep = options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  let attempt = 0;
  while (attempt <= maxAttempts) {
    attempt += 1;
    try {
      return await operation(attempt);
    } catch (error) {
      await sleep(baseDelayMs);
      if (attempt > maxAttempts) throw error;
    }
  }
}
