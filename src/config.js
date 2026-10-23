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

// Comparación con Steam
export const STEAM = {
  // País de Steam e idioma de búsqueda para cada mercado de Xbox
  markets: {
    'es-AR': { cc: 'ar', lang: 'spanish', currency: 'USD' },
    'es-MX': { cc: 'mx', lang: 'spanish', currency: 'MXN' },
    'es-CL': { cc: 'cl', lang: 'spanish', currency: 'CLP' },
    'es-CO': { cc: 'co', lang: 'spanish', currency: 'COP' },
    'pt-BR': { cc: 'br', lang: 'brazilian', currency: 'BRL' },
    'es-ES': { cc: 'es', lang: 'spanish', currency: 'EUR' },
    'en-US': { cc: 'us', lang: 'english', currency: 'USD' },
  },
  // Key de la Web API de Steam (https://steamcommunity.com/dev/apikey): permite bajar la lista completa de
  // juegos y emparejar casi todo al instante. Sin key se usa solo la búsqueda por nombre (más lenta).
  apiKey: process.env.STEAM_API_KEY || '',
  // Búsquedas por nombre por actualización, para los juegos que no aparecen en la lista completa
  matchesPerRun: Number(process.env.STEAM_MATCHES_PER_RUN) || 150,
  // Pausa entre búsquedas, para quedar debajo del límite de Steam (~200 pedidos cada 5 min)
  searchDelayMs: Number(process.env.STEAM_SEARCH_DELAY_MS) || 1600,
  // Cada cuántos días se vuelve a buscar un juego que no se encontró (puede salir en Steam después)
  retryUnmatchedDays: 14,
  // Tipo de dólar de dolarapi.com para convertir precios de Steam (USD) a pesos: oficial, tarjeta, blue, mep…
  dollarType: process.env.STEAM_DOLLAR || 'oficial',
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
