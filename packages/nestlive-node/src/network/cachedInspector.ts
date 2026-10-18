/** Share expensive Windows adapter inspection across clients. Audio telemetry never uses this cache. */
export function cachedInspector<T>(inspect: () => Promise<T>, ttlMs = 10000, now = Date.now) {
  let cached: { value: T; expiresAt: number } | undefined;
  let inFlight: Promise<T> | undefined;
  return () => {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;
    inFlight = inspect().then(value => {
      cached = { value, expiresAt: now() + ttlMs };
      return value;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
