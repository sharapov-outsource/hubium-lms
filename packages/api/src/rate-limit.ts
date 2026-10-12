// Fixed-window rate limit per token, in process memory. With several web replicas the
// effective limit is per replica; good enough to stop runaway scripts.

export function rateLimit(perMinute: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string) => {
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= 60_000) {
      w = { start: t, count: 0 };
      windows.set(key, w);
      if (windows.size > 10_000)
        for (const [k, v] of windows) if (t - v.start >= 60_000) windows.delete(k);
    }
    w.count++;
    return {
      allowed: w.count <= perMinute,
      limit: perMinute,
      remaining: Math.max(0, perMinute - w.count),
      retryAfterSec: Math.ceil((w.start + 60_000 - t) / 1000),
    };
  };
}
