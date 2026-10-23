export const PORT = Number(process.env.PORT) || 3000;

// Mercado por defecto (define moneda y precios). Ej: es-AR, es-MX, en-US, es-ES
export const DEFAULT_LOCALE = process.env.LOCALE || 'es-AR';

export const LOCALES = {
  'es-AR': 'Argentina (ARS)',
  'es-MX': 'México (MXN)',
  'es-CL': 'Chile (CLP)',
  'es-CO': 'Colombia (COP)',
  'pt-BR': 'Brasil (BRL)',
  'es-ES': 'España (EUR)',
  'en-US': 'Estados Unidos (USD)',
};

// Mercados que se actualizan automáticamente (separados por coma). Ej: es-AR,es-MX
export const SCRAPE_LOCALES = (process.env.SCRAPE_LOCALES || DEFAULT_LOCALE)
  .split(',').map((l) => l.trim()).filter((l) => LOCALES[l]);

// Cada cuántas horas se actualizan los precios automáticamente
export const REFRESH_HOURS = Number(process.env.REFRESH_HOURS) || 6;

// Tiempo mínimo entre actualizaciones manuales (botón de la web), para no saturar a Microsoft
export const REFRESH_COOLDOWN_MIN = Number(process.env.REFRESH_COOLDOWN_MIN) || 30;

// Carpeta de la base de datos (en un hosting, apuntarla a un volumen persistente)
export const DATA_DIR = process.env.DATA_DIR || 'data';

// Detrás de un proxy (Fly, Railway, Cloudflare…) hay que confiar en él para saber la IP real del visitante
export const TRUST_PROXY = process.env.TRUST_PROXY || (process.env.NODE_ENV === 'production' ? '1' : '');

// Listas que se descargan de la tienda. maxPages * 25 = cantidad de juegos
export const LISTS = {
  deals: { orderby: 'DiscountPercentage desc', maxPages: 80, stopWhenNoDiscount: true },
  popular: { orderby: 'MostPopular desc', maxPages: 8 },
  wishlisted: { orderby: 'WishlistCountTotal desc', maxPages: 8 },
  newest: { orderby: 'ReleaseDate desc', maxPages: 4 },
};

// Bot de Discord (opcional). Se configura en .env — ver README
export const DISCORD = {
  token: process.env.DISCORD_TOKEN || '',
  // Servidor donde registrar los comandos (aparecen al instante). Sin esto se registran globales (tardan hasta 1 h)
  guildId: process.env.DISCORD_GUILD_ID || '',
  // Canal donde publicar las ofertas nuevas de juegos populares/deseados (opcional)
  channelId: process.env.DISCORD_CHANNEL_ID || '',
  // Descuento mínimo para publicar una oferta en el canal
  minDiscount: Number(process.env.DISCORD_MIN_DISCOUNT) || 50,
  // Solo se publican en el canal juegos dentro de este top de populares o más deseados
  topRank: Number(process.env.DISCORD_TOP_RANK) || 100,
  // Máximo de juegos que puede seguir cada usuario
  maxFollows: Number(process.env.DISCORD_MAX_FOLLOWS) || 50,
  locale: process.env.DISCORD_LOCALE || DEFAULT_LOCALE,
};
