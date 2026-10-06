// Minimales Rate-Limit im Arbeitsspeicher (pro IP und Route).
// Schützt vor allem die kostenpflichtigen Aufrufe (KI, Google Solar) vor Missbrauch.
// Bei mehreren Server-Instanzen durch Redis o. Ä. ersetzen.

export function rateLimit({ windowMs, max }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10_000) cleanup(now);
      return next();
    }
    if (entry.count >= max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Zu viele Anfragen – bitte versuchen Sie es gleich noch einmal.' });
    }
    entry.count++;
    next();
  };

  function cleanup(now) {
    for (const [key, entry] of hits) if (now > entry.resetAt) hits.delete(key);
  }
}
