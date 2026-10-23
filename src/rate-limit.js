// Límite simple de pedidos por IP (ventana fija). Suficiente para un solo proceso.
export function rateLimit({ windowMs, max, message = 'Demasiados pedidos, probá en un rato' }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const count = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, count);
    if (count > max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
