const buckets = new Map();

export function rateLimit({ windowMs, max, skipSuccessful = false, message = 'Demasiadas solicitudes, intenta mas tarde' }) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const key = `${req.rateLimitBucket || 'general'}:${ip}`;
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || now - entry.firstAt > windowMs) {
      entry = { count: 0, firstAt: now };
      buckets.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.firstAt + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', '0');
      res.status(429).json({ error: 'rate_limited', message });
      return Promise.resolve();
    }
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    const p = next();
    if (skipSuccessful && p && typeof p.then === 'function') {
      return p.then(() => {
        if (res.statusCode < 400) entry.count--;
      });
    }
    return p;
  };
}
