// Caché en memoria de resultados de consultas. Los datos solo cambian cuando termina una
// actualización de precios, así que se vacía entera en ese momento (clear) en vez de expirar por tiempo.
const MAX_ENTRIES = 1000;
const store = new Map();

export function cached(key, compute) {
  if (store.has(key)) return store.get(key);
  const value = compute();
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value); // descarta la más vieja
  store.set(key, value);
  return value;
}

export function clearCache() {
  store.clear();
}
