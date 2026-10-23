# Store Sales

Web app que lee los precios de juegos de Microsoft Store / Xbox, guarda un historial y detecta ofertas y bajadas de precio.

Funciona de dos formas:

| | **Publicado gratis** (GitHub Actions + Pages) | **Servidor** (`npm start`) |
|---|---|---|
| Web | Sí, URL fija `usuario.github.io/repo` | Sí, `localhost:3000` |
| Actualización de precios | Cada 6 h + botón "Run workflow" en GitHub | Cada 6 h + botón en la web |
| Discord | Alertas en un canal (webhook) | Bot completo: `/seguir`, mensajes privados, etc. |
| Costo | Gratis | Necesita una máquina prendida |

## Qué hace

- **En oferta**: juegos con descuento, con % y fecha de fin de la oferta.
- **Bajaron de precio**: el precio actual es menor al registrado en la actualización anterior.
- **Mínimo histórico**: en oferta y al precio más bajo que se registró (requiere haberlo visto más caro antes).
- **Más populares / Más deseados / Novedades / Gratis / Todos**.
- **★ Seguidos**: juegos que marcás con la estrella (se guardan en el navegador).
- Filtros: búsqueda, plataforma, género, Game Pass, descuento mínimo y orden.
- Detalle con historial de precio (gráfico) y link a la tienda.
- Varios mercados (`SCRAPE_LOCALES=es-AR,es-MX,…`); cada uno tiene su propio historial.

## Comparación con Steam

Cada juego de Xbox se empareja con su equivalente en Steam (`src/steam.js`). La comparación aparece en la tarjeta
(una fila por tienda, con la más barata resaltada), en el detalle (una tabla Xbox vs Steam con historial de las
dos) y en los avisos de Discord. Filtros: **Más barato en Xbox / en Steam**, **En oferta en Steam**, **En oferta
en las dos**, y el orden **Mayor diferencia con Steam**.

**Cómo se empareja, para que no compare cosas distintas:**

1. **Nombre**: los nombres se normalizan (sin ™, sin "(PC)" ni "para Xbox One…", y "Edición Definitiva" pasa a
   "Definitive Edition") y se buscan **exactos** en la lista completa de juegos de Steam (~200.000, se baja con
   `STEAM_API_KEY`). Los que no aparecen (por ejemplo, con el nombre en español) se buscan en la tienda, de a
   `STEAM_MATCHES_PER_RUN` por actualización.
2. **Empresa**: se confirma que el editor o desarrollador coincida (con alias como Microsoft = Xbox Game Studios).
   Si no coincide, solo se acepta si el nombre es idéntico, único en Steam y no genérico. Así "Decay" o
   "Extinction", que tienen varios juegos con el mismo nombre, no se comparan.
3. **Edición**: entre las opciones de compra de Steam se elige la **misma edición** (la Digital Deluxe de Xbox se
   compara con la Digital Deluxe de Steam). Si Steam no la tiene, se muestra la estándar como referencia, con la
   etiqueta "Otra edición" y sin decir cuál conviene.

Con la key, todo el catálogo se empareja en unos 3 minutos; sin la key, solo con búsquedas, lleva varios días.
Las empresas y las ediciones salen de `IStoreBrowseService/GetItems`, que trae 100 juegos por pedido y no necesita key.

**Transparencia y correcciones:**
- El detalle dice con qué se comparó ("Comparado con *Dying Light 2 Stay Human: Reloaded Edition* · Techland").
- El link **"¿La comparación está mal? Reportalo"** abre un issue en GitHub con los datos ya completados.
- Para corregir, en `steam-overrides.json`: `"ID_XBOX": appid` fuerza el juego de Steam, y `"ID_XBOX": null` marca
  que no tiene equivalente. Se aplica en la próxima actualización.
- En cada juego, Steam aparece como "buscando…", "no está en Steam", "sin coincidencia segura" (no se pudo
  confirmar que sea el mismo), "sin precio en Steam" (gratis o no se vende en ese país), o con el precio y cuál conviene.

**Moneda**: en Argentina Steam cobra en USD y Xbox en pesos. Las dos tiendas suman los mismos impuestos al pagar
(IVA 21% + IIBB), así que se comparan los precios base convirtiendo con el dólar de [dolarapi.com](https://dolarapi.com)
(`STEAM_DOLLAR`, por defecto `oficial`; también `tarjeta`, `mep`, `blue`). En los otros mercados, Steam cobra en la
misma moneda que Xbox.

**En local:** `npm run steam` empareja y actualiza Steam sin volver a pedir los precios de Xbox. Con `npm run dev`
abierto, recargá la página cuando termine.

## Publicar gratis en GitHub Pages

Cómo funciona: `.github/workflows/update.yml` corre cada 6 h en GitHub Actions. Recupera la base SQLite de la rama
`data`, pide los precios a Microsoft, manda las alertas a Discord y genera el sitio estático (`npm run build`, que
produce HTML, JS y un JSON con los juegos de cada mercado). Publica el sitio en GitHub Pages y guarda la base actualizada en
la rama `data`, siempre en un solo commit que se pisa, así el repo no crece. La web filtra todo en el navegador
(unos 800 juegos, ~100 KB comprimidos).

**Pasos (una sola vez)**

1. Creá un repositorio **público** en GitHub. Pages es gratis solo en repos públicos, y Actions tiene minutos
   ilimitados en repos públicos. Las claves van en *secrets*, que no se ven.
2. Subí el proyecto:
   ```bash
   git init -b main
   git add .
   git commit -m "Store Sales"
   git remote add origin https://github.com/TU_USUARIO/store-sales.git
   git push -u origin main
   ```
3. En el repo: **Settings → Pages → Source: GitHub Actions**.
4. Comparación con Steam: sacá una key en <https://steamcommunity.com/dev/apikey> y guardala en
   **Settings → Secrets and variables → Actions → New repository secret** con el nombre `STEAM_API_KEY`.
   Sin la key también funciona, pero el emparejamiento tarda días en completarse.
5. (Opcional) Alertas en Discord: en tu servidor de Discord, **Editar canal → Integraciones → Webhooks →
   Nuevo webhook → Copiar URL**. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**,
   nombre `DISCORD_WEBHOOK_URL`.
6. (Opcional) En la misma pantalla, pestaña **Variables**: `SCRAPE_LOCALES` (ej. `es-AR,es-MX`),
   `DISCORD_MIN_DISCOUNT` (50), `DISCORD_TOP_RANK` (100).
7. **Actions → Actualizar precios y publicar → Run workflow** para la primera carga. Tarda unos 2 minutos y al
   terminar muestra la URL del sitio.

Para tener en cuenta:
- GitHub puede demorar los cron unos minutos, y **desactiva los workflows programados si el repo pasa 60 días sin
  actividad** (te avisa por mail y se reactivan con un clic).
- GitHub Pages cachea los archivos unos 10 minutos.
- El webhook publica en el canal las ofertas nuevas de juegos que están en el top `DISCORD_TOP_RANK` de populares o
  más deseados y tienen al menos `DISCORD_MIN_DISCOUNT`% de descuento. `/seguir` y los mensajes privados necesitan el
  bot completo (modo servidor).

## Modo servidor (local)

```bash
npm install
npm start          # http://localhost:3000
```

Si los datos tienen más de `REFRESH_HOURS` horas, se actualizan al arrancar y después cada `REFRESH_HOURS`.
También se puede actualizar con el botón de la web o con `npm run scrape -- es-AR`. La configuración va en `.env`
(ver `.env.example`).

### Bot de Discord

Se activa si hay `DISCORD_TOKEN` en `.env`.

| Comando | Qué hace |
|---|---|
| `/ofertas [min_descuento] [plataforma] [orden]` | Top 15 de juegos en oferta |
| `/bajadas` | Juegos que bajaron de precio en la última actualización |
| `/precio juego` | Precio actual, original, mínimo registrado y fin de la oferta |
| `/seguir juego` | Te avisa por mensaje privado cuando ese juego baja de precio |
| `/dejar juego` | Deja de seguirlo |
| `/seguidos` | Tus juegos seguidos con su precio actual |

Después de cada actualización, el bot manda un mensaje privado a quien sigue un juego que bajó, y (con
`DISCORD_CHANNEL_ID`) publica en el canal las ofertas de juegos populares.

Setup: en <https://discord.com/developers/applications> → **New Application** → **Bot → Reset Token**. Después,
**OAuth2 → URL Generator** con los scopes `bot` y `applications.commands` y los permisos `Send Messages` y `Embed Links`,
e invitalo a tu servidor. Para copiar los IDs del servidor y del canal, activá **Modo desarrollador** en Discord.
Completá `DISCORD_TOKEN`, `DISCORD_GUILD_ID` y `DISCORD_CHANNEL_ID` en `.env`.

Para compartirlo desde tu Mac sin hosting: `brew install cloudflared`, `TRUST_PROXY=1 npm start` y
`cloudflared tunnel --url http://localhost:3000`, que te da una URL pública temporal. También hay un `Dockerfile`
para un hosting con disco persistente (la base va en `/data`).

## Seguridad y límites

- **Pedidos a Microsoft**: en Pages, 4 actualizaciones por día. En modo servidor, además del automático, el botón solo
  funciona si pasaron `REFRESH_COOLDOWN_MIN` (30 min) desde la última actualización, con máximo 10 intentos por hora
  por IP. Cada pedido tiene timeout de 20 s y reintenta con espera (1 s, 4 s, 9 s) ante errores 429/5xx.
- **Base de datos**: la web no consulta la base en cada visita. El JSON de cada mercado se genera una vez por
  actualización: como archivo estático en Pages, o en memoria en el modo servidor, que se vacía al actualizar.
  Las escrituras del scraper van en transacciones, de a una página.
- **Modo servidor**: 120 pedidos por minuto por IP, parámetros validados, errores sin stack traces y headers CSP,
  `X-Frame-Options`, `nosniff` y `no-referrer`.
- **Frontend**: CSP también por `<meta>` (Pages no permite headers propios); se escapa todo lo que se inserta en el HTML.
- **Discord**: máximo `DISCORD_MAX_FOLLOWS` (50) juegos seguidos por usuario, y markdown escapado. El token y el
  webhook van en `.env` o en *secrets*, nunca en el código.
- La web es de solo lectura: no hay cuentas.

## Cómo funciona por dentro

- `src/scraper.js` consulta `emerald.xboxservices.com/xboxcomfd/browse`, la API interna que usa xbox.com/games/browse
  (la API pública de listas de Microsoft Store, `reco-public`, está deprecada). Descarga todas las ofertas (ordenadas
  por descuento), los 200 más populares, los 200 más deseados y novedades.
- SQLite (`node:sqlite`, nativo de Node 22): en `price_history` se agrega una fila solo cuando el precio cambia.
- Si una oferta deja de aparecer en la lista de ofertas, se marca como terminada y el precio vuelve al original.
- `src/export.js` arma el JSON que lee la web; `src/build.js` genera el sitio estático; `src/server.js` es el modo
  servidor.

## Limitaciones

- Es una API no oficial: Microsoft puede cambiarla sin aviso.
- Solo se rastrean los juegos que aparecen en esas listas.
- El historial empieza la primera vez que corre: las bajadas y el mínimo histórico aparecen a partir de la segunda
  actualización.
