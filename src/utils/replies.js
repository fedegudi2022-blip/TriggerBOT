// Estilo visual unificado de TriggerBOT: colores por tipo de mensaje + footer de marca.
// brandEmbed acepta thumbnail, image y author; los helpers de formato son compartidos
// por las fichas de información (/ping, /status, /userinfo, /serverinfo, /estadisticas).
const { EmbedBuilder } = require('discord.js');

// Paleta única del bot. Los cuatro primeros son SEMÁNTICOS (éxito/error/neutro/
// atención) y los usa successEmbed/errorEmbed/warnEmbed; los "acento" son colores de
// tema que no significan nada por sí mismos. Todo hex del bot vive acá: cambiar la
// identidad visual es editar este objeto, no 15 archivos.
const COLORS = {
  success: 0x57f287,
  error: 0xed4245,
  info: 0x5865f2,
  warn: 0xfee75c,
  // Acentos temáticos.
  servidor: 0x9b59b6, // fichas de servidor (/serverinfo)
  carino: 0xe91e63, // interacciones (/beso, /abrazo…)
  logro: 0xf1c40f, // logros completos y medallas
  neutral: 0x2c2f33, // embeds "de ambiente" (/8ball)
  reddit: 0xff4500, // marca de Reddit (/meme)
  gris: 0x99aab5, // salidas, rangos bajos y estados "apagado"
  naranja: 0xe67e22, // aviso intermedio (softban aplicado, rol quitado)
};

// ---------- Política de visibilidad de las respuestas ----------
// Para que no haya que adivinar si un comando contesta en público o en privado:
//
// · EFÍMERO (solo lo ve quien lo usó): todo lo que expone datos de una persona
//   (/userinfo, /avatar, /warnings, /warns propios) o que es una respuesta de
//   trámite/configuración que no le interesa al resto del canal (/config, /ticket
//   categoría, /frases lista, errores de uso).
// · PÚBLICO (lo ve el canal): lo que es contenido para la comunidad (/top,
//   /logros, /redes, /web, /ip, /servidores, /meme, /encuesta) y los anuncios de
//   acción moderativa, porque la transparencia es parte de la moderación — siempre
//   con la opción `silencioso:true` para que el staff lo haga en privado cuando el
//   caso lo pida.
// · Las sanciones se anuncian en público pero el DM al sancionado es privado y
//   solo se manda si la acción se aplicó realmente.

function brandEmbed({ color = COLORS.info, title, description, fields, footer, thumbnail, image, author }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: footer || 'TriggerBOT' });
  if (author) embed.setAuthor({ name: author.name || '', iconURL: author.iconURL, url: author.url });
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (fields?.length) embed.addFields(fields);
  if (thumbnail) embed.setThumbnail(thumbnail);
  // Acepta "https://..." o { url: "https://..." } (algunos comandos pasan el objeto completo).
  if (image) embed.setImage(typeof image === 'string' ? image : (image.url ?? null));
  return embed;
}

const successEmbed = (description, title = 'Acción completada') => brandEmbed({ color: COLORS.success, title, description });

const errorEmbed = (description, title = 'No se pudo completar') => brandEmbed({ color: COLORS.error, title, description });

const warnEmbed = (description, title = 'Atención') => brandEmbed({ color: COLORS.warn, title, description });

const infoEmbed = (description, title) => brandEmbed({ color: COLORS.info, title, description });

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

// ---------- Mensajes de acciones de moderación ----------
// Un solo constructor para TODAS las confirmaciones de moderación (kick, ban,
// timeout, mute...). Es lo que hace que el bot se sienta consistente: mismo título,
// mismo motivo, misma duración y mismo número de caso, sin importar qué comando se usó.

// Motivo uniforme: nunca "*sin especificar*", "Sin especificar" y "—" en tres
// comandos distintos por la misma razón.
function motivoTexto(motivo, { vacio = 'No especificado' } = {}) {
  const limpio = String(motivo ?? '').trim();
  return limpio || `*${vacio}*`;
}

// Marca de tiempo de Discord: el cliente la muestra en la hora local de cada persona
// y, con "R", como "en 2 horas". Mejor que una fecha escrita a mano.
function marcaTiempo(ms, formato = 'R') {
  return `<t:${Math.floor(Number(ms) / 1000)}:${formato}>`;
}

// Milisegundos → texto corto en español: "45 minutos", "1 hora", "28 días".
function textoDuracion(ms) {
  const total = Math.max(Math.round(Number(ms) / 1000), 1);
  const dias = Math.floor(total / 86400);
  const horas = Math.floor((total % 86400) / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const segundos = total % 60;
  const partes = [];
  if (dias) partes.push(`${dias} día${dias === 1 ? '' : 's'}`);
  if (horas) partes.push(`${horas} hora${horas === 1 ? '' : 's'}`);
  if (minutos) partes.push(`${minutos} minuto${minutos === 1 ? '' : 's'}`);
  if (!partes.length) partes.push(`${segundos} segundo${segundos === 1 ? '' : 's'}`);
  return partes.join(' ');
}

// Embed estándar de resultado de una acción: título, detalle, motivo, duración,
// campos extra y el caso del mod-log en el footer.
function accionEmbed({ color = COLORS.success, titulo, detalle, motivo, duracionTexto, caso, moderador, campos = [], thumbnail, footer } = {}) {
  const fields = [];
  if (motivo !== undefined) fields.push({ name: 'Motivo', value: motivoTexto(motivo), inline: false });
  if (duracionTexto) fields.push({ name: 'Duración', value: duracionTexto, inline: true });
  fields.push(...campos);

  const pie = ['TriggerBOT', caso ? `caso #${caso}` : null, moderador ? `por ${moderador}` : null, footer].filter(Boolean).join(' • ');

  return brandEmbed({ color, title: titulo, description: detalle, fields: fields.length ? fields : undefined, thumbnail, footer: pie });
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

module.exports = {
  COLORS,
  brandEmbed,
  successEmbed,
  errorEmbed,
  warnEmbed,
  infoEmbed,
  accionEmbed,
  motivoTexto,
  marcaTiempo,
  textoDuracion,
  miles,
  compacto,
  duracion,
  barra,
  UMBRALES,
  nivel,
};
