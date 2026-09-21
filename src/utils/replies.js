// Estilo visual unificado de TriggerBOT: colores por tipo de mensaje + footer de marca.
// brandEmbed acepta thumbnail, image y author; los helpers de formato son compartidos
// por las fichas de información (/ping, /status, /userinfo, /serverinfo, /estadisticas).
const { EmbedBuilder } = require('discord.js');

const COLORS = {
  success: 0x57f287,
  error: 0xed4245,
  info: 0x5865f2,
  warn: 0xfee75c,
};

function brandEmbed({ color = COLORS.info, title, description, fields, footer, thumbnail, image, author }) {
  const embed = new EmbedBuilder().setColor(color).setTimestamp().setFooter({ text: footer || 'TriggerBOT' });
  if (author) embed.setAuthor({ name: author.name || '', iconURL: author.iconURL, url: author.url });
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (fields?.length) embed.addFields(fields);
  if (thumbnail) embed.setThumbnail(thumbnail);
  // Acepta "https://..." o { url: "https://..." } (algunos comandos pasan el objeto completo).
  if (image) embed.setImage(typeof image === 'string' ? image : image.url ?? null);
  return embed;
}

const successEmbed = (description, title = 'Acción completada') =>
  brandEmbed({ color: COLORS.success, title, description });

const errorEmbed = (description, title = 'No se pudo completar') =>
  brandEmbed({ color: COLORS.error, title, description });

const warnEmbed = (description, title = 'Atención') =>
  brandEmbed({ color: COLORS.warn, title, description });

const infoEmbed = (description, title) =>
  brandEmbed({ color: COLORS.info, title, description });

// ---------- Helpers de formato para las fichas ----------

// 1234567 → "1.234.567" (separador de miles estilo es-AR, sin decimales).
function miles(n) {
  return Number(n || 0).toLocaleString('es-AR');
}

// 99000 → "99 mil" · 1234567 → "1,2 M" — para cifras grandes en espacios chicos.
function compacto(n) {
  n = Number(n || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (n >= 10_000) return `${Math.round(n / 1000)} mil`;
  return miles(n);
}

// Segundos → "3 d 4 h 12 m" (o la unidad más grande que corresponda).
function duracion(segundos) {
  const d = Math.floor(segundos / 86400);
  const h = Math.floor((segundos % 86400) / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = Math.floor(segundos % 60);
  if (d > 0) return `${d} d ${h} h ${m} m`;
  if (h > 0) return `${h} h ${m} m`;
  if (m > 0) return `${m} m ${s} s`;
  return `${s} s`;
}

// Barra de progreso de emojis: "▰▰▰▱▱▱ 50%" (el estilo █░ queda para /estadisticas).
function barra(n, total, ancho = 10) {
  const llenos = Math.round(Math.min(Math.max(n / (total || 1), 0), 1) * ancho);
  return `${'▰'.repeat(llenos)}${'▱'.repeat(ancho - llenos)}`;
}

// Umbrales para colorear latencias y memoria según qué tan bien están.
const UMBRALES = {
  ping: { genial: 60, ok: 150, malo: 400 }, // ms
  memoria: { genial: 150, ok: 350, malo: 700 }, // MB rss
};

// Etiqueta de calidad con color: 🟢 genial · 🟡 aceptable · 🔴 malo.
function nivel(valor, umbral) {
  if (valor <= umbral.genial) return { emoji: '🟢', texto: 'Excelente' };
  if (valor <= umbral.ok) return { emoji: '🟡', texto: 'Bien' };
  if (valor <= umbral.malo) return { emoji: '🟠', texto: 'Regular' };
  return { emoji: '🔴', texto: 'Alto' };
}

module.exports = { COLORS, brandEmbed, successEmbed, errorEmbed, warnEmbed, infoEmbed, miles, compacto, duracion, barra, UMBRALES, nivel };
