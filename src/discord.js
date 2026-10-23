import {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, EmbedBuilder, REST, Routes, MessageFlags, escapeMarkdown,
} from 'discord.js';
import { db } from './db.js';
import { cached } from './cache.js';
import { DISCORD } from './config.js';
import { onScrapeDone } from './scraper.js';
import { steamComparison } from './steam.js';

const LOCALE = DISCORD.locale;
const COLORS = { sale: 0xffd23f, drop: 0x4fc3f7, info: 0x107c10 };
const PLATFORMS = [
  { name: 'Xbox Series X|S', value: 'XboxSeriesX' },
  { name: 'Xbox One', value: 'XboxOne' },
  { name: 'PC', value: 'PC' },
  { name: 'Cloud', value: 'XCloud' },
];

// ---------- Helpers ----------

function money(value, currency) {
  if (value === 0) return 'Gratis';
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency, maximumFractionDigits: value % 1 ? 2 : 0 }).format(value);
}

const storeUrl = (id) => `https://www.xbox.com/${LOCALE}/games/store/x/${id}`;
const imageUrl = (url) => (url ? `${url}?q=80&w=200&h=300` : null);
const discordDate = (iso) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;

const getGame = db.prepare(`
  SELECT p.*, pr.currency, pr.price, pr.msrp, pr.discount, pr.sale_end, pr.previous_price, pr.lowest_price
  FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.locale = ?
  WHERE p.id = ?
`);

function priceLine(g) {
  let line = `**${money(g.price, g.currency)}**`;
  if (g.msrp > g.price) line += ` ~~${money(g.msrp, g.currency)}~~ (-${g.discount}%)`;
  return line;
}

function gameEmbed(g, { title, color } = {}) {
  const embed = new EmbedBuilder()
    .setColor(color ?? (g.discount > 0 ? COLORS.sale : COLORS.info))
    .setTitle(title ?? g.title)
    .setURL(storeUrl(g.id))
    .setDescription(priceLine(g));
  const fields = [];
  if (g.oldPrice !== undefined) fields.push({ name: 'Antes', value: money(g.oldPrice, g.currency), inline: true });
  if (g.lowest_price !== undefined && g.lowest_price !== null) {
    fields.push({ name: 'Mínimo registrado', value: money(g.lowest_price, g.currency), inline: true });
  }
  if (g.sale_end) fields.push({ name: 'Oferta termina', value: discordDate(g.sale_end), inline: true });
  if (g.game_pass || g.gamePass) fields.push({ name: 'Game Pass', value: 'Incluido', inline: true });
  const steam = steamField(g);
  if (steam) fields.push(steam);
  if (fields.length) embed.addFields(fields);
  const img = imageUrl(g.image);
  if (img) embed.setThumbnail(img);
  return embed;
}

// "Steam: $ 7.750 (USD 5) · 🟢 Xbox 40% menos"
function steamField(g) {
  const s = steamComparison(g.id, LOCALE, g);
  if (!s) return null;
  let value = `[${s.priceLocal !== null ? money(s.priceLocal, g.currency) : `${s.currency} ${s.price}`}](https://store.steampowered.com/app/${s.appid})`;
  if (s.currency !== g.currency) value += ` (${s.currency} ${s.price})`;
  if (s.discount > 0) value += ` -${s.discount}%`;
  if (s.cheaper === 'xbox') value += `\n🟢 Xbox ${s.diffPct}% menos`;
  if (s.cheaper === 'steam') value += `\n🔴 Steam ${s.diffPct}% menos`;
  if (s.cheaper === 'equal') value += '\n⚪ Mismo precio';
  if (s.edition === 'standard_only') value += '\n⚠️ Steam solo tiene la edición estándar (referencia)';
  return { name: 'Steam', value, inline: false };
}

// Lista compacta para /ofertas, /seguidos, /bajadas (una sola embed con hasta 15 líneas)
function listEmbed(title, games, emptyText) {
  const lines = games.map((g, i) => {
    // Sin corchetes ni markdown en el título para que no rompa el link
    const title = escapeMarkdown(g.title.replace(/[[\]]/g, ''));
    let line = `${i + 1}. [${title}](${storeUrl(g.id)}) — ${priceLine(g)}`;
    if (g.previous_price && g.previous_price > g.price && !(g.msrp > g.price)) {
      line += ` ~~${money(g.previous_price, g.currency)}~~`;
    }
    return line;
  });
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(title)
    .setDescription(lines.join('\n').slice(0, 4000) || emptyText);
}

// ---------- Comandos ----------

const gameOption = (o) => o.setName('juego').setDescription('Nombre del juego').setRequired(true).setAutocomplete(true);

const commands = [
  new SlashCommandBuilder().setName('ofertas').setDescription('Muestra los juegos en oferta')
    .addIntegerOption((o) => o.setName('min_descuento').setDescription('Descuento mínimo (%)').setMinValue(1).setMaxValue(100))
    .addStringOption((o) => o.setName('plataforma').setDescription('Plataforma').addChoices(...PLATFORMS))
    .addStringOption((o) => o.setName('orden').setDescription('Orden').addChoices(
      { name: 'Mayor descuento', value: 'discount' },
      { name: 'Más populares', value: 'popular' },
      { name: 'Más baratos', value: 'price' },
      { name: 'Terminan antes', value: 'sale_end' },
    )),
  new SlashCommandBuilder().setName('bajadas').setDescription('Juegos que bajaron de precio en la última actualización'),
  new SlashCommandBuilder().setName('precio').setDescription('Precio actual de un juego').addStringOption(gameOption),
  new SlashCommandBuilder().setName('seguir').setDescription('Te aviso por mensaje privado cuando baje de precio').addStringOption(gameOption),
  new SlashCommandBuilder().setName('dejar').setDescription('Dejar de seguir un juego').addStringOption(gameOption),
  new SlashCommandBuilder().setName('seguidos').setDescription('Los juegos que seguís y su precio actual'),
];

const OFERTAS_ORDER = {
  discount: 'pr.discount DESC, COALESCE(r.position, 99999)',
  popular: 'COALESCE(r.position, 99999), pr.discount DESC',
  price: 'pr.price ASC',
  sale_end: 'pr.sale_end IS NULL, pr.sale_end ASC',
};

const handlers = {
  async ofertas(i) {
    const min = i.options.getInteger('min_descuento') ?? 1;
    const platform = i.options.getString('plataforma');
    const order = OFERTAS_ORDER[i.options.getString('orden') ?? 'popular'];
    const params = [LOCALE, LOCALE, min];
    let extra = '';
    if (platform) { extra = 'AND EXISTS (SELECT 1 FROM json_each(p.platforms) WHERE value = ?)'; params.push(platform); }
    const games = cached(`discord:ofertas:${JSON.stringify(params)}:${order}`, () => db.prepare(`
      SELECT p.*, pr.* FROM prices pr JOIN products p ON p.id = pr.product_id
      LEFT JOIN rankings r ON r.product_id = p.id AND r.locale = ? AND r.list = 'popular'
      WHERE pr.locale = ? AND pr.discount >= ? ${extra}
      ORDER BY ${order} LIMIT 15
    `).all(...params));
    await i.reply({ embeds: [listEmbed(`Ofertas${min > 1 ? ` (-${min}% o más)` : ''}`, games, 'No hay ofertas con esos filtros.')] });
  },

  async bajadas(i) {
    const games = cached('discord:bajadas', () => db.prepare(`
      SELECT p.*, pr.* FROM prices pr JOIN products p ON p.id = pr.product_id
      WHERE pr.locale = ? AND pr.previous_price IS NOT NULL AND pr.price < pr.previous_price
      ORDER BY pr.changed_at DESC, (pr.previous_price - pr.price) * 1.0 / pr.previous_price DESC LIMIT 15
    `).all(LOCALE));
    await i.reply({ embeds: [listEmbed('Bajaron de precio', games, 'Todavía no se detectaron bajadas. Aparecen a partir de la segunda actualización de precios.')] });
  },

  async precio(i) {
    const g = getGame.get(LOCALE, i.options.getString('juego'));
    if (!g) return i.reply({ content: 'No encontré ese juego. Elegilo de la lista que aparece al escribir.', flags: MessageFlags.Ephemeral });
    await i.reply({ embeds: [gameEmbed(g)] });
  },

  async seguir(i) {
    const g = getGame.get(LOCALE, i.options.getString('juego'));
    if (!g) return i.reply({ content: 'No encontré ese juego. Elegilo de la lista que aparece al escribir.', flags: MessageFlags.Ephemeral });
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM discord_follows WHERE user_id = ?').get(i.user.id);
    if (n >= DISCORD.maxFollows) {
      return i.reply({ content: `Ya seguís ${n} juegos, que es el máximo. Usá \`/dejar\` para liberar lugar.`, flags: MessageFlags.Ephemeral });
    }
    db.prepare('INSERT OR IGNORE INTO discord_follows VALUES (?, ?, ?, ?)').run(i.user.id, g.id, LOCALE, new Date().toISOString());
    await i.reply({
      content: `Listo, te aviso por privado cuando **${g.title}** baje de precio.`,
      embeds: [gameEmbed(g)],
      flags: MessageFlags.Ephemeral,
    });
  },

  async dejar(i) {
    const id = i.options.getString('juego');
    const { changes } = db.prepare('DELETE FROM discord_follows WHERE user_id = ? AND product_id = ? AND locale = ?').run(i.user.id, id, LOCALE);
    const g = getGame.get(LOCALE, id);
    await i.reply({
      content: changes ? `Dejaste de seguir **${g?.title ?? id}**.` : 'No seguías ese juego.',
      flags: MessageFlags.Ephemeral,
    });
  },

  async seguidos(i) {
    const games = db.prepare(`
      SELECT p.*, pr.* FROM discord_follows f
      JOIN products p ON p.id = f.product_id
      JOIN prices pr ON pr.product_id = f.product_id AND pr.locale = f.locale
      WHERE f.user_id = ? AND f.locale = ? ORDER BY p.title LIMIT 25
    `).all(i.user.id, LOCALE);
    await i.reply({ embeds: [listEmbed('Tus juegos seguidos', games, 'No seguís ningún juego. Usá `/seguir`.')], flags: MessageFlags.Ephemeral });
  },
};

// Autocompletado del nombre del juego. Para /dejar sugiere solo los que seguís.
function autocomplete(i) {
  const text = `%${String(i.options.getFocused()).slice(0, 100)}%`;
  const rows = i.commandName === 'dejar'
    ? db.prepare(`
        SELECT p.id, p.title, pr.price, pr.currency FROM discord_follows f
        JOIN products p ON p.id = f.product_id JOIN prices pr ON pr.product_id = p.id AND pr.locale = f.locale
        WHERE f.user_id = ? AND f.locale = ? AND p.title LIKE ? ORDER BY p.title LIMIT 25
      `).all(i.user.id, LOCALE, text)
    : cached(`discord:ac:${text.toLowerCase()}`, () => db.prepare(`
        SELECT p.id, p.title, pr.price, pr.currency FROM products p
        JOIN prices pr ON pr.product_id = p.id AND pr.locale = ?
        LEFT JOIN rankings r ON r.product_id = p.id AND r.locale = pr.locale AND r.list = 'popular'
        WHERE p.title LIKE ? ORDER BY COALESCE(r.position, 99999), p.title LIMIT 25
      `).all(LOCALE, text));
  return i.respond(rows.map((r) => ({
    name: `${r.title} — ${money(r.price, r.currency)}`.slice(0, 100),
    value: r.id,
  })));
}

// ---------- Alertas después de cada actualización ----------

async function notify(client, { locale, drops }) {
  if (locale !== LOCALE || !drops.length) return;
  const byId = new Map(drops.map((d) => [d.id, d]));

  // 1) Mensaje privado a cada usuario que sigue un juego que bajó
  const follows = db.prepare(`SELECT user_id, product_id FROM discord_follows WHERE locale = ? AND product_id IN (${drops.map(() => '?').join(',')})`)
    .all(locale, ...byId.keys());
  const perUser = Map.groupBy(follows, (f) => f.user_id);
  for (const [userId, rows] of perUser) {
    const embeds = rows.map((r) => {
      const g = { ...getGame.get(locale, r.product_id), oldPrice: byId.get(r.product_id).oldPrice };
      return gameEmbed(g, { title: `↓ ${g.title}`, color: COLORS.drop });
    });
    try {
      const user = await client.users.fetch(userId);
      for (let k = 0; k < embeds.length; k += 10) {
        await user.send({ content: k ? undefined : '¡Bajó de precio un juego que seguís!', embeds: embeds.slice(k, k + 10) });
      }
    } catch (err) {
      console.error(`[discord] No pude mandar DM a ${userId}:`, err.message);
    }
  }

  // 2) Canal público: ofertas de juegos populares o muy deseados
  if (!DISCORD.channelId) return;
  const messages = highlightMessages(locale, drops);
  if (!messages.length) return;
  try {
    const channel = await client.channels.fetch(DISCORD.channelId);
    for (const m of messages) await channel.send(m);
  } catch (err) {
    console.error('[discord] No pude publicar en el canal:', err.message);
  }
}

// Mensajes con las bajadas de juegos populares/deseados con buen descuento (máx. 10 embeds por mensaje).
// Los usa el bot (canal) y el webhook del build estático.
export function highlightMessages(locale, drops) {
  const rank = db.prepare(`SELECT MIN(position) AS pos FROM rankings WHERE product_id = ? AND locale = ? AND list IN ('popular', 'wishlisted')`);
  const highlights = drops
    .map((d) => ({ ...d, rank: rank.get(d.id, locale).pos }))
    .filter((d) => d.discount >= DISCORD.minDiscount && d.rank && d.rank <= DISCORD.topRank)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 20);
  const embeds = highlights.map((d) => gameEmbed({ ...getGame.get(locale, d.id), oldPrice: d.oldPrice }));
  const messages = [];
  for (let k = 0; k < embeds.length; k += 10) {
    messages.push({ content: k ? undefined : `🔥 **${highlights.length} ofertas nuevas** en juegos populares`, embeds: embeds.slice(k, k + 10) });
  }
  return messages;
}

// ---------- Arranque ----------

export async function startDiscordBot() {
  if (!DISCORD.token) {
    console.log('[discord] DISCORD_TOKEN no configurado: bot desactivado');
    return null;
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async (c) => {
    const rest = new REST().setToken(DISCORD.token);
    const body = commands.map((cmd) => cmd.toJSON());
    const route = DISCORD.guildId
      ? Routes.applicationGuildCommands(c.user.id, DISCORD.guildId)
      : Routes.applicationCommands(c.user.id);
    await rest.put(route, { body });
    console.log(`[discord] Conectado como ${c.user.tag} · ${body.length} comandos registrados${DISCORD.guildId ? ' en el servidor' : ' (globales)'}`);
  });

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.isAutocomplete()) return await autocomplete(i);
      if (i.isChatInputCommand() && handlers[i.commandName]) await handlers[i.commandName](i);
    } catch (err) {
      console.error(`[discord] Error en /${i.commandName}:`, err);
      if (i.isRepliable() && !i.replied) {
        await i.reply({ content: 'Ocurrió un error.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  onScrapeDone((result) => notify(client, result));
  await client.login(DISCORD.token);
  return client;
}

// Exportados para pruebas
export { commands, handlers, autocomplete, notify };
