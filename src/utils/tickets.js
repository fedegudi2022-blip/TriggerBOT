// Sistema de tickets de soporte: un panel con selector de tipo en un canal; al elegir
// uno se abre el formulario del tipo y se crea un canal privado visible solo por el
// usuario y el staff. El staff puede reclamarlo (queda a su nombre), sumar gente y
// cerrarlo. Al cerrar se genera un transcript HTML legible, se manda a los logs, se
// borra el canal y el usuario recibe una encuesta 1-5 para calificar la atención.
// Tipos: soporte, apelación y reporte de cheater (ver TIPOS). /reportar abre un
// reporte sin pasar por el panel.
//
// El cierre pide un MOTIVO (resuelto / no resuelto / duplicado / otro) antes de
// ejecutarse, y los tickets sin actividad se cierran solos a las 72 h (configurable
// con /ticket inactividad), con un aviso una hora antes.
//
// Config (config.tickets en store.js): { categoriaId, canalLogs, mensajes, contador,
//   activos, encuestas, calificaciones, cierres, horasInactividad }
// Estado de cada ticket (en el topic del canal): guildId:userId:numero:tipo
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { nombreDe, brandEmbed, COLORS, textoDuracion } = require('./replies');
const { getGuildConfig, setGuildConfig } = require('../store');
const { autorizadoDe } = require('./permisos');
const crearLogger = require('../logger');

const log = crearLogger('tickets');

function configDe(guildId) {
  return getGuildConfig(guildId).tickets ?? {};
}

// ---------- Tipos de ticket ----------
// Cada tipo define su etiqueta, el prefijo del canal y las preguntas de su modal.
// Es la única fuente: el panel, los formularios, el embed del ticket y el resumen
// del cierre salen de acá, así agregar un tipo es agregar una entrada.
const TIPOS = {
  soporte: {
    etiqueta: 'Soporte',
    descripcion: 'Dudas, problemas técnicos o con tu cuenta',
    prefijo: 'soporte',
    campos: [{ id: 'motivo', etiqueta: 'Contanos qué necesitás', max: 500, parrafo: true }],
  },
  apelacion: {
    etiqueta: 'Apelación',
    descripcion: 'Pedí que revisen una sanción (ban, mute, warn)',
    prefijo: 'apelacion',
    campos: [
      { id: 'sancion', etiqueta: 'Qué sanción apelás (y cuándo)', max: 200 },
      { id: 'motivo', etiqueta: 'Por qué deberíamos levantarla', max: 500, parrafo: true },
    ],
  },
  reporte: {
    etiqueta: 'Reporte de cheater',
    descripcion: 'Reportá a alguien con pruebas (captura, video, demo)',
    prefijo: 'reporte',
    campos: [
      { id: 'reportado', etiqueta: 'Usuario o ID del reportado', max: 100 },
      { id: 'pruebas', etiqueta: 'Qué hizo y qué pruebas tenés', max: 500, parrafo: true },
      { id: 'adjunto', etiqueta: 'Link a las pruebas (opcional)', max: 200, requerido: false },
    ],
  },
};
const TIPO_POR_DEFECTO = 'soporte';
const MAX_CALIFICACIONES = 100; // se guardan las últimas: es un termómetro, no un archivo
const MAX_CIERRES = 200; // historial para /ticket stats (motivos y tiempos)

// Motivos de cierre: el staff elige uno al cerrar. `inactividad` no se ofrece en el
// selector porque la usa el cierre automático.
const MOTIVOS_CIERRE = [
  { valor: 'resuelto', etiqueta: 'Resuelto', descripcion: 'El problema o la consulta quedó solucionada' },
  { valor: 'no_resuelto', etiqueta: 'No resuelto', descripcion: 'Se cerró sin dar una solución' },
  { valor: 'duplicado', etiqueta: 'Duplicado', descripcion: 'Ya había otro ticket con el mismo tema' },
  { valor: 'otro', etiqueta: 'Otro motivo', descripcion: 'Cierre administrativo o caso particular' },
];
const MOTIVO_POR_DEFECTO = MOTIVOS_CIERRE[0];

// Auto-cierre por inactividad: 72 h por defecto, con aviso una hora antes. La
// actividad se anota como mucho una vez cada 5 min para no escribir la config en cada
// mensaje de un ticket activo.
const HORAS_INACTIVIDAD_POR_DEFECTO = 72;
const AVISO_INACTIVIDAD_MS = 60 * 60 * 1000;
const ACTIVIDAD_MINIMA_MS = 5 * 60 * 1000;

// Tipo con su id incluido (así el resto del código usa tipo.id / tipo.prefijo).
function tipoDe(id) {
  return TIPOS[id] ? { id, ...TIPOS[id] } : null;
}

// ---------- Estado de los tickets abiertos ----------
// config.tickets.activos[canalId] = { numero, userId, tipo, ts, reclamadoPor, reclamadoEn }
// Vive en la config para que un reinicio del bot no le borre el tipo, el número ni
// quién lo estaba atendiendo.
function activoDe(guildId, canalId) {
  return configDe(guildId).activos?.[canalId] ?? null;
}

function marcarActivo(guildId, canalId, datos) {
  setGuildConfig(guildId, (c) => {
    c.tickets = c.tickets || {};
    c.tickets.activos = c.tickets.activos || {};
    c.tickets.activos[canalId] = { ...(c.tickets.activos[canalId] ?? {}), ...datos };
  });
  return activoDe(guildId, canalId);
}

function borrarActivo(guildId, canalId) {
  setGuildConfig(guildId, (c) => {
    if (!c.tickets?.activos?.[canalId]) return;
    delete c.tickets.activos[canalId];
    if (!Object.keys(c.tickets.activos).length) delete c.tickets.activos;
  });
}

// Datos del ticket leídos del topic (fuente original) cruzados con lo guardado.
// Sirve para tickets abiertos antes de este cambio: sin entrada en `activos`
// igual se sabe quién lo abrió, el número y el tipo.
function datosDeCanal(canal) {
  const [guildId, userId, numero, tipo] = String(canal.topic ?? '').split(':');
  return { guildId: guildId ?? canal.guild.id, userId: userId ?? null, numero: numero ?? null, tipo: tipoDe(tipo) ?? tipoDe(TIPO_POR_DEFECTO) };
}

// Límite de adjunto de Discord (8 MiB sin boosts). Dejamos margen: si el transcript
// lo supera, se parte en varios archivos en vez de que el envío falle en silencio.
const LIMITE_ADJUNTO_BYTES = 7_800_000;
// Gracia antes de borrar el canal ya cerrado (los tests la bajan a 0).
const GRACIA_MS = 30_000;

// ---------- Transcript HTML ----------
// El .txt era ilegible para el staff: sin autores destacados, sin adjuntos clicables y
// sin formato. El HTML conserva los saltos de línea, muestra avatar, hora y adjuntos, y
// se puede abrir en cualquier navegador. Se parte por MENSAJE (no por línea) para no
// cortar una etiqueta HTML al medio; cada parte es un documento completo.
function escaparHtml(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function urlSegura(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function fechaLegible(ms) {
  try {
    return new Date(ms).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}

function bloqueMensaje(mensaje) {
  const avatar = urlSegura(mensaje.avatar);
  const adjuntos = mensaje.adjuntos
    .map((url) => urlSegura(url))
    .filter(Boolean)
    .map((url, i) => `<a href="${escaparHtml(url)}" rel="noopener noreferrer">adjunto ${i + 1}</a>`)
    .join(' · ');
  const embeds = mensaje.embeds
    .map((e) => `<div class="embed">${e.titulo ? `<strong>${escaparHtml(e.titulo)}</strong>` : ''}${e.descripcion ? `<p>${escaparHtml(e.descripcion)}</p>` : ''}</div>`)
    .join('');

  return (
    `<article class="msg" id="m-${escaparHtml(mensaje.id)}">` +
    (avatar ? `<img class="avatar" src="${escaparHtml(avatar)}" alt="" loading="lazy">` : '<div class="avatar sin-foto"></div>') +
    '<div class="burbuja">' +
    `<div class="cab"><span class="autor">${escaparHtml(mensaje.autor)}</span>` +
    `<time datetime="${new Date(mensaje.ts).toISOString()}" title="${escaparHtml(new Date(mensaje.ts).toISOString())}">${escaparHtml(fechaLegible(mensaje.ts))}</time></div>` +
    `<div class="texto">${escaparHtml(mensaje.contenido).replace(/\n/g, '<br>') || '<em>(sin texto)</em>'}</div>` +
    (embeds ? `<div class="embeds">${embeds}</div>` : '') +
    (adjuntos ? `<div class="adjuntos">📎 ${adjuntos}</div>` : '') +
    '</div></article>'
  );
}

function documentoHtml({ titulo, meta, cuerpo, parte, total }) {
  return (
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escaparHtml(titulo)}</title><style>` +
    ':root{color-scheme:dark}body{margin:0;background:#1e1f22;color:#dbdee1;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}' +
    'main{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 8px}' +
    '.meta{color:#949ba4;font-size:13px;margin:0 0 4px}.meta b{color:#dbdee1}' +
    '.aviso{margin:16px 0;padding:10px 12px;border-left:4px solid #f0b232;background:#2b2d31;border-radius:4px}' +
    '.chat{display:flex;flex-direction:column;gap:10px;margin-top:20px}' +
    '.msg{display:flex;gap:10px;align-items:flex-start}.avatar{width:38px;height:38px;border-radius:50%;flex:none;background:#5865f2}' +
    '.avatar.sin-foto{opacity:.35}.burbuja{background:#2b2d31;border-radius:8px;padding:8px 12px;min-width:0;flex:1}' +
    '.cab{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.autor{font-weight:700;color:#f2f3f5}' +
    'time{color:#949ba4;font-size:12px}.texto{margin-top:4px;overflow-wrap:anywhere}.texto a{color:#00a8fc}' +
    '.embed{margin-top:6px;border-left:3px solid #5865f2;padding-left:8px}.embed p{margin:2px 0}' +
    '.adjuntos{margin-top:6px;font-size:13px}.adjuntos a{color:#00a8fc}' +
    'footer{margin-top:28px;color:#949ba4;font-size:12px;text-align:center}' +
    '</style></head><body><main>' +
    `<h1>${escaparHtml(titulo)}</h1>` +
    meta.map((linea) => `<p class="meta">${linea}</p>`).join('') +
    (total > 1 ? `<p class="aviso">Parte ${parte} de ${total} del transcript.</p>` : '') +
    '<section class="chat">' +
    cuerpo +
    '</section><footer>TriggerBOT • transcript generado automáticamente</footer></main></body></html>'
  );
}

// Arma las partes del HTML respetando el límite de adjuntos. Devuelve [{ attachment, name }].
function partesTranscriptHtml(mensajes, meta) {
  const nombreBase = `transcript-${meta.canalNombre}.html`;
  const titulo = `Ticket #${meta.numero} — ${meta.tipo}`;
  const lineasMeta = [
    `Servidor: <b>${escaparHtml(meta.guildNombre)}</b>`,
    `Canal: <b>#${escaparHtml(meta.canalNombre)}</b>`,
    `Abierto por: <b>${escaparHtml(meta.abiertoPor)}</b> · Atendido por: <b>${escaparHtml(meta.atendidoPor)}</b>`,
    `Cerrado por: <b>${escaparHtml(meta.cerradoPor)}</b> · Motivo: <b>${escaparHtml(meta.motivo)}</b>`,
    `Mensajes: <b>${mensajes.length}</b>` + (meta.integro ? '' : ' · <b>INCOMPLETO</b>'),
  ];
  if (!meta.integro) {
    lineasMeta.push(`⚠️ ${escaparHtml(meta.parcial ? 'Falló la lectura de mensajes.' : 'Se superó el tope de mensajes guardados.')}`);
  }

  const bloques = mensajes.map(bloqueMensaje);
  const vacio = documentoHtml({ titulo, meta: lineasMeta, cuerpo: '<p class="meta">Sin mensajes.</p>', parte: 1, total: 1 });
  const base = Buffer.byteLength(vacio, 'utf8');
  const grupos = [];
  let actual = [];
  let bytes = base;

  for (const bloque of bloques) {
    const tamano = Buffer.byteLength(bloque, 'utf8');
    if (actual.length && bytes + tamano > LIMITE_ADJUNTO_BYTES) {
      grupos.push(actual);
      actual = [];
      bytes = base;
    }
    actual.push(bloque);
    bytes += tamano;
  }
  if (actual.length || !grupos.length) grupos.push(actual);

  const total = grupos.length;
  return grupos.map((grupo, i) => ({
    attachment: Buffer.from(
      documentoHtml({ titulo, meta: lineasMeta, cuerpo: grupo.join(''), parte: i + 1, total }),
      'utf8'
    ),
    name: total > 1 ? nombreBase.replace(/\.html$/, `-parte-${i + 1}.html`) : nombreBase,
  }));
}

// Parte un transcript de texto en archivos de a lo sumo LIMITE_ADJUNTO_BYTES, cortando
// por línea y numerando las partes (se mantiene para compatibilidad y tests).
function dividirTranscript(cabecera, lineas, nombreBase) {
  const partes = [];
  let actual = cabecera;
  let bytes = Buffer.byteLength(actual, 'utf8');
  for (const linea of lineas) {
    const lineaBytes = Buffer.byteLength(linea, 'utf8') + 1;
    if (bytes + lineaBytes > LIMITE_ADJUNTO_BYTES && actual !== cabecera) {
      partes.push(actual);
      actual = '';
      bytes = 0;
    }
    actual += linea + '\n';
    bytes += lineaBytes;
  }
  if (actual) partes.push(actual);
  if (!partes.length) partes.push(cabecera);

  const total = partes.length;
  return partes.map((texto, i) => ({
    attachment: Buffer.from((total > 1 ? `# Transcript — parte ${i + 1}/${total}\n` : '') + texto, 'utf8'),
    name: total > 1 ? nombreBase.replace(/\.txt$/, `-parte-${i + 1}.txt`) : nombreBase,
  }));
}

// Contador de tickets por server (para el número #001, #002...).
function siguienteNumero(guildId) {
  let n = 1;
  setGuildConfig(guildId, (c) => {
    c.tickets = c.tickets || {};
    c.tickets.contador = (c.tickets.contador || 0) + 1;
    n = c.tickets.contador;
  });
  return n;
}

function esStaff(member) {
  return autorizadoDe(member.guild, member, PermissionFlagsBits.ManageGuild);
}

function botonesTicket() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:reclamar').setLabel('Reclamar').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:agregar').setLabel('Agregar usuario').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:cerrar').setLabel('Cerrar ticket').setStyle(ButtonStyle.Danger)
  );
}

// Bloqueo anti-carrera: dos clics casi simultáneos pueden pasar ambos el chequeo de
// "ya tenés un ticket" antes de que ninguno creara el canal → dos tickets por persona.
// Mientras se crea el canal, el userId queda en este Set y el segundo intento sale.
const abriendoAhora = new Set();

// Abre un ticket para el usuario. Devuelve el canal creado o { error }.
async function abrirTicket(interaction, { tipo: tipoId = TIPO_POR_DEFECTO, campos = {} } = {}) {
  const guild = interaction.guild;
  const user = interaction.user;
  const config = configDe(guild.id);
  const raiz = getGuildConfig(guild.id);
  const tipo = tipoDe(tipoId) ?? tipoDe(TIPO_POR_DEFECTO);

  const claveAbriendo = `${guild.id}:${user.id}`;
  if (abriendoAhora.has(claveAbriendo)) {
    return { error: 'Ya estoy abriendo tu ticket, esperá unos segundos...' };
  }
  abriendoAhora.add(claveAbriendo);
  try {
    return await abrirTicketInterno(interaction, { tipo, campos }, { config, raiz });
  } finally {
    abriendoAhora.delete(claveAbriendo);
  }
}

async function abrirTicketInterno(interaction, { tipo, campos }, { config, raiz }) {
  const guild = interaction.guild;
  const user = interaction.user;

  // Un ticket abierto por persona (los canales llevan el userId en el topic).
  const existente = guild.channels.cache.find((c) => c.topic?.startsWith(`${guild.id}:${user.id}:`));
  if (existente) return { error: `Ya tenés un ticket abierto: <#${existente.id}>` };

  const numero = siguienteNumero(guild.id);
  const numeroTxt = String(numero).padStart(3, '0');

  const overrides = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
    {
      id: interaction.client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels],
    },
  ];
  // El staff entra por roles configurados; sin config, quien tenga ManageGuild lo ve igual.
  for (const rolId of [raiz.adminRole, raiz.modRole, raiz.helperRole].filter(Boolean)) {
    if (guild.roles.cache.has(rolId)) {
      overrides.push({
        id: rolId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
      });
    }
  }

  const canal = await guild.channels.create({
    name: `${tipo.prefijo}-${numeroTxt}`,
    type: ChannelType.GuildText,
    parent: config.categoriaId && guild.channels.cache.has(config.categoriaId) ? config.categoriaId : null,
    permissionOverwrites: overrides,
    topic: `${guild.id}:${user.id}:${numeroTxt}:${tipo.id}`,
    reason: `Ticket de ${nombreDe(user)} (${tipo.etiqueta})`,
  });

  // Lo que el usuario escribió en el formulario, con la etiqueta de cada pregunta.
  const detalle = tipo.campos
    .map((campo) => (campos?.[campo.id] ? `**${campo.etiqueta}:** ${campos[campo.id]}` : null))
    .filter(Boolean)
    .join('\n');

  await canal.send({
    content: `${user}, acá está tu ticket. El staff te va a responder a la brevedad.`,
    embeds: [
      brandEmbed({
        color: COLORS.info,
        title: `Ticket #${numeroTxt} — ${tipo.etiqueta}`,
        description: `**Usuario:** ${user} (\`${nombreDe(user)}\`)\n\n${detalle || '*sin detalle*'}`,
        footer: 'TriggerBOT • el staff puede reclamarlo, sumar gente o cerrarlo',
      }),
    ],
    components: [botonesTicket()],
  });

  // Queda anotado para el cierre: tipo, número, apertura y quién lo atiende.
  marcarActivo(guild.id, canal.id, { numero: numeroTxt, userId: user.id, tipo: tipo.id, ts: Date.now() });

  loguear(guild, {
    color: COLORS.success,
    title: 'Ticket abierto',
    description: `${user} abrió el ticket **#${numeroTxt}** (${tipo.etiqueta}) → <#${canal.id}>`,
  });

  return { canal, numero };
}

// Cierra el ticket del canal actual: transcript, DM, encuesta de calificación, log y
// borra el canal (30 s de gracia, configurable para los tests).
async function cerrarTicket(interaction, cerradoPor, { graciaMs = GRACIA_MS, motivo, motivoClave = null } = {}) {
  return cerrarCanal(interaction.channel, cerradoPor, { graciaMs, motivo, motivoClave });
}

// Núcleo del cierre, sin depender de una interacción: lo usan el botón/selector y el
// auto-cierre por inactividad. Devuelve true si el canal quedó cerrado y borrado.
async function cerrarCanal(canal, cerradoPor, { graciaMs = GRACIA_MS, motivo = MOTIVO_POR_DEFECTO.etiqueta, motivoClave = null } = {}) {
  const [, userId, numero] = canal.topic?.split(':') ?? [];
  const guild = canal.guild;
  const activo = activoDe(guild.id, canal.id);
  const tipo = tipoDe(activo?.tipo) ?? tipoDe(canal.topic?.split(':')[3]) ?? tipoDe(TIPO_POR_DEFECTO);
  const atendidoPor = activo?.reclamadoPor ?? null;
  const duracionMs = activo?.ts ? Date.now() - activo.ts : null;
  const duracionTxt = duracionMs === null ? null : textoDuracion(duracionMs);
  const motivoFinal = String(motivo ?? '').trim() || MOTIVO_POR_DEFECTO.etiqueta;
  // Se resuelve una sola vez: el nombre del dueño va en el HTML y el mismo usuario
  // recibe el DM con la copia (antes se pedía dos veces).
  const duenio = userId ? await guild.client.users.fetch(userId).catch(() => null) : null;
  const miembroAtendedor = atendidoPor ? guild.members?.cache?.get?.(atendidoPor) ?? null : null;
  const nombreAtendedor = atendidoPor
    ? miembroAtendedor
      ? nombreDe(miembroAtendedor.user, miembroAtendedor)
      : `ID ${atendidoPor}`
    : 'nadie lo reclamó';

  await canal.send({
    embeds: [brandEmbed({ color: COLORS.warn, title: 'Generando transcript…', description: `El canal se cierra en un momento, ${nombreDe(cerradoPor)}.` })],
  }).catch(() => {});

  // Transcript: todos los mensajes del canal, en orden (de a 100 por fetch).
  // Tope práctico: 50.000 mensajes (500 páginas). Un ticket normal nunca llega.
  // Si un fetch falla o la conversación es más larga que el tope, el transcript
  // queda marcado como INCOMPLETO y no se borra el canal (ver más abajo).
  const MAX_PAGINAS = 500;
  const mensajes = [];
  let antes = null;
  let parcial = false; // un fetch falló a mitad: no sabemos si faltan mensajes
  let truncado = false; // se alcanzó el tope de páginas guardando solo una parte
  for (let vuelta = 0; vuelta < MAX_PAGINAS; vuelta++) {
    let lote;
    try {
      lote = await canal.messages.fetch({ limit: 100, before: antes });
    } catch (error) {
      parcial = true;
      log.warn('No se pudo leer un lote del transcript', error, { canal: canal.id });
      break;
    }
    if (!lote?.size) break;
    for (const m of lote.values()) {
      mensajes.push({
        id: m.id,
        ts: m.createdTimestamp,
        autor: nombreDe(m.author),
        avatar: m.author?.displayAvatarURL?.({ size: 64 }) ?? null,
        contenido: m.content || '',
        adjuntos: [...(m.attachments?.values?.() ?? [])].map((a) => a.url),
        embeds: [...(m.embeds ?? [])].map((e) => ({ titulo: e.title ?? e.data?.title ?? '', descripcion: e.description ?? e.data?.description ?? '' })),
      });
    }
    antes = lote.last().id;
    if (lote.size < 100) break;
    if (vuelta === MAX_PAGINAS - 1) truncado = true; // quedaba más y cortamos
  }
  mensajes.reverse();
  const integro = !parcial && !truncado;

  const partes = partesTranscriptHtml(mensajes, {
    guildNombre: guild.name,
    canalNombre: canal.name,
    numero,
    tipo: tipo.etiqueta,
    abiertoPor: duenio ? nombreDe(duenio) : (userId ?? 'desconocido'),
    atendidoPor: nombreAtendedor,
    cerradoPor: nombreDe(cerradoPor),
    motivo: motivoFinal,
    integro,
    parcial,
  });

  const config = configDe(guild.id);
  const raiz = getGuildConfig(guild.id);
  const canalLogs = guild.channels.cache.get(config.canalLogs || raiz.logs || raiz.avisosChannel);

  // 1) Copia al canal de logs (o logs/avisos general como fallback). Es el requisito
  //    para poder borrar el canal: si no está configurado o algún envío falla, el
  //    transcript NO quedó a salvo.
  let guardadoEnLogs = false;
  if (canalLogs) {
    guardadoEnLogs = true;
    for (let i = 0; i < partes.length; i++) {
      const ok = await canalLogs
        .send({
          embeds:
            i === 0
              ? [
                  brandEmbed({
                    color: COLORS.warn,
                    title: `Ticket #${numero} cerrado`,
                    description:
                      `**Tipo:** ${tipo.etiqueta}\n**Abierto por:** <@${userId}>\n**Atendido por:** ${atendidoPor ? `<@${atendidoPor}>` : '*nadie lo reclamó*'}\n` +
                      `**Cerrado por:** ${nombreDe(cerradoPor)}\n**Motivo:** ${motivoFinal}` +
                      `${duracionTxt ? `\n**Duración:** ${duracionTxt}` : ''}\n**Mensajes:** ${mensajes.length}` +
                      (integro ? '' : '\n⚠️ **Transcript incompleto**'),
                  }),
                ]
              : undefined,
          files: [partes[i]],
        })
        .then(() => true)
        .catch((error) => {
          log.warn('No se pudo enviar una parte del transcript a logs', error, { canal: canalLogs.id, parte: i + 1 });
          return false;
        });
      if (!ok) guardadoEnLogs = false;
    }
  }

  // 2) Copia por DM al usuario del ticket (mejor esfuerzo: no decide el cierre).
  if (userId) {
    if (duenio) {
      for (let i = 0; i < partes.length; i++) {
        await duenio
          .send({
            embeds:
              i === 0
                ? [
                    brandEmbed({
                      color: COLORS.info,
                      title: `Tu ticket #${numero} fue cerrado`,
                      description:
                        `Gracias por contactar al staff de **${guild.name}**. Motivo: **${motivoFinal}**. Te dejamos la conversación por si la necesitás.` +
                        (integro ? '' : '\n⚠️ El transcript quedó incompleto.'),
                    }),
                  ]
                : undefined,
            files: [partes[i]],
          })
          .catch(() => {});
      }
    }
  }

  // 3) Solo se borra el canal si el transcript ÍNTEGRO quedó guardado en logs. Si
  //    no, se conserva la conversación y se avisa al staff para que reintente.
  if (!integro || !guardadoEnLogs) {
    const motivoFallo = !integro
      ? parcial
        ? 'no pude leer todos los mensajes del canal'
        : 'la conversación supera el tope de mensajes que puedo guardar de una vez'
      : canalLogs
        ? `no pude enviar el transcript a <#${canalLogs.id}>`
        : 'no hay un canal de logs configurado para tickets (`/ticket logs`)';
    await canal
      .send({
        embeds: [
          brandEmbed({
            color: COLORS.error,
            title: '⚠️ No cerré el ticket',
            description:
              `No pude guardar el transcript completo: ${motivoFallo}.\n` +
              '**Este canal no se borra** para no perder la conversación. Arreglá el problema y volvé a cerrar el ticket.',
          }),
        ],
      })
      .catch(() => {});
    loguear(guild, {
      color: COLORS.error,
      title: `⚠️ Ticket #${numero} sin cerrar (transcript incompleto)`,
      description: `Por ${nombreDe(cerradoPor)} · ${motivoFallo}. El canal quedó abierto.`,
    });
    return false;
  }

  // Resumen del staff con lo que importa para saber qué pasó con el ticket.
  const resumen = [
    `**Tipo:** ${tipo.etiqueta}`,
    `**Abierto por:** <@${userId}>`,
    `**Atendido por:** ${atendidoPor ? `<@${atendidoPor}>` : '*nadie lo reclamó*'}`,
    `**Cerrado por:** ${nombreDe(cerradoPor)}`,
    `**Motivo:** ${motivoFinal}`,
    ...(duracionTxt ? [`**Duración:** ${duracionTxt}`] : []),
    `**Mensajes:** ${mensajes.length}`,
  ].join('\n');

  await canal.send({
    embeds: [
      brandEmbed({
        color: COLORS.warn,
        title: `Ticket cerrado por ${nombreDe(cerradoPor)}`,
        description: `${resumen}\n\nSe guardó un transcript HTML con **${mensajes.length}** mensajes. El canal se borra en **30 segundos**.`,
      }),
    ],
  }).catch(() => {});

  // Encuesta 1-5 al dueño del ticket (le dice al staff cómo estuvo la atención).
  const encuestaEnviada = await pedirCalificacion(guild, { userId, numero, atendidoPor, cerradoPor });

  registrarCierre(guild.id, {
    numero,
    userId: userId ?? null,
    tipo: tipo.id,
    motivo: motivoFinal,
    motivoClave: motivoClave ?? 'otro',
    cerradoPor: cerradoPor?.id ?? null,
    atendidoPor,
    duracionMs,
    mensajes: mensajes.length,
    ts: Date.now(),
  });

  loguear(guild, {
    color: COLORS.warn,
    title: `Ticket #${numero} cerrado`,
    description:
      `Por ${nombreDe(cerradoPor)} · motivo: **${motivoFinal}** · transcript HTML enviado a logs y al DM del usuario.` +
      (encuestaEnviada ? ' Se le pidió una calificación de 1 a 5.' : ' No pude mandarle la encuesta por DM.'),
  });

  // El ticket ya no está activo: se limpia el estado (reclamo incluido).
  borrarActivo(guild.id, canal.id);

  await new Promise((r) => {
    setTimeout(r, graciaMs);
  });
  await canal.delete(`Ticket cerrado por ${nombreDe(cerradoPor)}`).catch(() => {});
  return true;
}

// ---------- Actividad y auto-cierre ----------
// Anota que el ticket tuvo movimiento. Se escribe como mucho cada 5 minutos: en un
// ticket con charla activa, guardar en cada mensaje sería escritura de config inútil
// (el debounce de store.js lo absorbe, pero el sync a MariaDB no).
function registrarActividad(canal, { ahora = Date.now() } = {}) {
  const guildId = canal?.guild?.id;
  if (!guildId || !canal.topic?.startsWith(`${guildId}:`)) return false;
  const activo = activoDe(guildId, canal.id);
  if (!activo) return false;
  const base = activo.ultimaActividad ?? activo.ts ?? 0;
  if (ahora - base < ACTIVIDAD_MINIMA_MS) return false;
  marcarActivo(guildId, canal.id, { ultimaActividad: ahora, avisoInactividad: false, inactividadFallida: false });
  return true;
}

const cerrandoAhora = new Set();

// Pasada del auto-cierre: avisa una hora antes y cierra al vencer el plazo. Es una
// función pura respecto del scheduler (recibe el cliente y el reloj) para poder probarla
// sin esperar 72 horas.
async function procesarInactividad(client, { ahora = Date.now(), horasPorDefecto = HORAS_INACTIVIDAD_POR_DEFECTO, avisoMs = AVISO_INACTIVIDAD_MS, graciaMs = GRACIA_MS } = {}) {
  const resumen = { cerrados: 0, avisados: 0, limpiados: 0, errores: 0 };

  for (const guild of client?.guilds?.cache?.values() ?? []) {
    const config = configDe(guild.id);
    const horas = Number.isFinite(Number(config.horasInactividad)) ? Number(config.horasInactividad) : horasPorDefecto;
    if (!(horas > 0)) continue; // 0 = auto-cierre apagado
    const limiteMs = horas * 60 * 60 * 1000;

    for (const [canalId, activo] of Object.entries(config.activos ?? {})) {
      const base = activo.ultimaActividad ?? activo.ts;
      if (!base || activo.inactividadFallida) continue;

      const canal = guild.channels?.cache?.get(canalId);
      if (!canal) {
        borrarActivo(guild.id, canalId);
        resumen.limpiados += 1;
        continue;
      }

      const transcurrido = ahora - base;
      if (transcurrido >= limiteMs) {
        if (cerrandoAhora.has(canalId)) continue;
        cerrandoAhora.add(canalId);
        try {
          const ok = await cerrarCanal(canal, client.user, {
            motivo: 'Cierre automático por inactividad',
            motivoClave: 'inactividad',
            graciaMs,
          });
          if (ok) resumen.cerrados += 1;
          else {
            // No se pudo guardar el transcript: no se reintenta en cada pasada (el
            // canal queda abierto para que el staff lo resuelva a mano).
            marcarActivo(guild.id, canalId, { inactividadFallida: true });
            resumen.errores += 1;
          }
        } catch (error) {
          marcarActivo(guild.id, canalId, { inactividadFallida: true });
          resumen.errores += 1;
          log.warn(`No pude cerrar por inactividad el ticket ${canalId}`, error, { guild: guild.id });
        } finally {
          cerrandoAhora.delete(canalId);
        }
      } else if (transcurrido >= limiteMs - avisoMs && !activo.avisoInactividad) {
        const aviso = await canal
          .send({
            content: activo.userId ? `<@${activo.userId}>` : undefined,
            embeds: [
              brandEmbed({
                color: COLORS.warn,
                title: 'Este ticket se cierra por inactividad',
                description:
                  `No hubo movimiento en **${Math.round(transcurrido / 3_600_000)} h**. Se cierra automáticamente en **1 hora**.\n` +
                  'Si todavía necesitás ayuda, escribí algo acá (o pedile al staff que responda) para mantenerlo abierto.',
              }),
            ],
            allowedMentions: activo.userId ? { users: [activo.userId] } : { parse: [] },
          })
          .then(() => true)
          .catch(() => false);
        if (aviso) {
          marcarActivo(guild.id, canalId, { avisoInactividad: true });
          resumen.avisados += 1;
        }
      }
    }
  }

  return resumen;
}

function registrarCierre(guildId, registro) {
  setGuildConfig(guildId, (c) => {
    c.tickets = c.tickets || {};
    c.tickets.cierres = [...(c.tickets.cierres ?? []), registro].slice(-MAX_CIERRES);
  });
  return registro;
}

// Resumen para /ticket stats: promedio, distribución, por staff y motivos de cierre.
function estadisticasTickets(guildId) {
  const config = configDe(guildId);
  const calificaciones = (config.calificaciones ?? []).filter((c) => Number.isFinite(c.valor));
  const valores = calificaciones.map((c) => c.valor);
  const promedio = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
  const distribucion = [1, 2, 3, 4, 5].map((valor) => ({ valor, cantidad: valores.filter((v) => v === valor).length }));

  const porStaff = new Map();
  for (const c of calificaciones) {
    if (!c.staffId) continue;
    const entrada = porStaff.get(c.staffId) ?? { staffId: c.staffId, total: 0, suma: 0 };
    entrada.total += 1;
    entrada.suma += c.valor;
    porStaff.set(c.staffId, entrada);
  }
  const staff = [...porStaff.values()]
    .map((e) => ({ staffId: e.staffId, total: e.total, promedio: e.suma / e.total }))
    .sort((a, b) => b.promedio - a.promedio || b.total - a.total);

  const cierres = config.cierres ?? [];
  const motivos = new Map();
  for (const c of cierres) {
    const clave = c.motivoClave ?? 'otro';
    motivos.set(clave, (motivos.get(clave) ?? 0) + 1);
  }

  const horasInactividad = Number.isFinite(Number(config.horasInactividad))
    ? Number(config.horasInactividad)
    : HORAS_INACTIVIDAD_POR_DEFECTO;

  return {
    total: calificaciones.length,
    promedio,
    distribucion,
    staff,
    ultimas: [...calificaciones].slice(-5).reverse(),
    cierres: cierres.length,
    motivos: [...motivos.entries()].map(([clave, cantidad]) => ({ clave, cantidad })).sort((a, b) => b.cantidad - a.cantidad),
    horasInactividad,
  };
}

// Selector con los motivos. Se muestra en un mensaje efímero al apretar «Cerrar».
function filaMotivosCierre() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket:motivo')
      .setPlaceholder('¿Por qué se cierra el ticket?')
      .addOptions(MOTIVOS_CIERRE.map((m) => ({ label: m.etiqueta, value: m.valor, description: m.descripcion })))
  );
}

// ---------- Calificación del cierre ----------
// Se pide una vez por cierre: el pendiente queda en la config (`tickets.encuestas`),
// así el usuario puede apretar el botón más tarde (incluso si el canal ya no existe).
function encuestaPendienteDe(guildId, userId) {
  return configDe(guildId).encuestas?.[userId] ?? null;
}

async function pedirCalificacion(guild, { userId, numero, atendidoPor, cerradoPor }) {
  if (!userId) return false;
  const duenio = await guild.client.users.fetch(userId).catch(() => null);
  if (!duenio) return false;

  const botones = new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map((n) =>
      new ButtonBuilder()
        .setCustomId(`ticket:calificar:${guild.id}:${n}`)
        .setLabel(`${n}/5`)
        .setStyle(n <= 2 ? ButtonStyle.Danger : n === 3 ? ButtonStyle.Secondary : ButtonStyle.Success)
    )
  );

  const enviado = await duenio
    .send({
      embeds: [
        brandEmbed({
          color: COLORS.info,
          title: `¿Cómo estuvo la atención del ticket #${numero}?`,
          description: `Te atendió ${atendidoPor ? `<@${atendidoPor}>` : `**${nombreDe(cerradoPor)}**`}. Tocá un número del 1 al 5: lo ve solo el staff.`,
        }),
      ],
      components: [botones],
    })
    .then(() => true)
    .catch(() => false);

  if (enviado) {
    setGuildConfig(guild.id, (c) => {
      c.tickets = c.tickets || {};
      c.tickets.encuestas = c.tickets.encuestas || {};
      c.tickets.encuestas[userId] = { numero, staffId: atendidoPor ?? null, ts: Date.now() };
    });
  }
  return enviado;
}

// Guarda la calificación y limpia el pendiente. Devuelve el registro guardado.
function guardarCalificacion(guildId, userId, { numero, staffId, valor }) {
  const registro = { numero, userId, staffId: staffId ?? null, valor, ts: Date.now() };
  setGuildConfig(guildId, (c) => {
    c.tickets = c.tickets || {};
    c.tickets.calificaciones = [...(c.tickets.calificaciones ?? []), registro].slice(-MAX_CALIFICACIONES);
    if (c.tickets.encuestas?.[userId]) {
      delete c.tickets.encuestas[userId];
      if (!Object.keys(c.tickets.encuestas).length) delete c.tickets.encuestas;
    }
  });
  return registro;
}

// Promedio de las últimas calificaciones (lo usa el aviso al staff).
function promedioCalificaciones(guildId) {
  const valores = (configDe(guildId).calificaciones ?? []).map((c) => c.valor).filter((v) => Number.isFinite(v));
  if (!valores.length) return null;
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

// ---------- Logs ----------
function loguear(guild, { color, title, description }) {
  const { logEvent } = require('./log');
  logEvent(guild, { color, title, description });
}

// ---------- Panel público con botón ----------
function panel(guild) {
  const config = configDe(guild.id);
  return {
    embeds: [
      brandEmbed({
        color: COLORS.info,
        title: 'Soporte',
        description:
          config.mensajes ||
          '¿Necesitás hablar con el staff? Abrí un ticket con el botón de abajo: se crea un canal privado solo para vos y el equipo.',
        footer: 'TriggerBOT • un ticket por persona',
      }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ticket:sel:tipo')
          .setPlaceholder('Elegí el tipo de ticket')
          .addOptions(Object.entries(TIPOS).map(([id, t]) => ({ label: t.etiqueta, value: id, description: t.descripcion })))
      ),
    ],
  };
}

// Modal con las preguntas del tipo elegido. Cada campo es una fila del modal.
function modalDeTipo(tipo) {
  const modal = new ModalBuilder().setCustomId(`ticket:modal:${tipo.id}`).setTitle(`Ticket — ${tipo.etiqueta}`);
  for (const campo of tipo.campos) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(campo.id)
          .setLabel(campo.etiqueta)
          .setStyle(campo.parrafo ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setMaxLength(campo.max)
          .setRequired(campo.requerido !== false)
      )
    );
  }
  return modal;
}

// ---------- Handlers de botones (conectados desde index.js) ----------

async function manejarBotonTicket(interaction) {
  const accion = interaction.customId.split(':')[1];

  // Panel viejo (publicado antes de los tipos): se asume soporte.
  if (accion === 'abrir') {
    return interaction.showModal(modalDeTipo(tipoDe(TIPO_POR_DEFECTO)));
  }

  // Reclamar: el ticket queda a nombre del staff que lo atiende.
  if (accion === 'reclamar') {
    if (!esStaff(interaction.member)) {
      return interaction.reply({ content: 'Solo el staff puede reclamar el ticket.', flags: MessageFlags.Ephemeral });
    }
    const guildId = interaction.guild.id;
    const canal = interaction.channel;
    const activo = activoDe(guildId, canal.id);
    if (activo?.reclamadoPor && activo.reclamadoPor !== interaction.user.id) {
      return interaction.reply({ content: `Este ticket ya lo está atendiendo <@${activo.reclamadoPor}>.`, flags: MessageFlags.Ephemeral });
    }
    const datos = datosDeCanal(canal);
    marcarActivo(guildId, canal.id, { reclamadoPor: interaction.user.id, reclamadoEn: Date.now(), numero: activo?.numero ?? datos.numero, tipo: activo?.tipo ?? datos.tipo.id, userId: activo?.userId ?? datos.userId });
    await canal
      .send({
        embeds: [
          brandEmbed({
            color: COLORS.success,
            title: 'Ticket reclamado',
            description: `${interaction.user} se está haciendo cargo del ticket. Ya no hace falta que otro del staff lo revise.`,
          }),
        ],
      })
      .catch(() => {});
    return interaction.reply({ content: 'Listo, el ticket quedó a tu nombre.', flags: MessageFlags.Ephemeral });
  }

  // Agregar gente al ticket (por ID o mención).
  if (accion === 'agregar') {
    if (!esStaff(interaction.member)) {
      return interaction.reply({ content: 'Solo el staff puede sumar gente al ticket.', flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder().setCustomId('ticket:modal:agregar').setTitle('Agregar usuario al ticket');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('usuario')
          .setLabel('ID o mención del usuario')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }

  if (accion === 'cerrar') {
    const canal = interaction.channel;
    const duenioId = canal.topic?.split(':')[1];
    const esDuenio = interaction.user.id === duenioId;
    if (!esDuenio && !esStaff(interaction.member)) {
      return interaction.reply({ content: 'Solo el dueño del ticket o el staff pueden cerrarlo.', flags: MessageFlags.Ephemeral });
    }
    // El motivo se pregunta ANTES de cerrar: el transcript y el log lo dejan asentado
    // (y /ticket stats puede mostrar por qué se cierran los tickets).
    return interaction.reply({
      embeds: [
        brandEmbed({
          color: COLORS.info,
          title: 'Cerrar ticket',
          description: 'Elegí el motivo del cierre. El usuario va a recibir el transcript HTML por DM y una encuesta de 1 a 5.',
        }),
      ],
      components: [filaMotivosCierre()],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Calificación 1-5 desde el DM (el customId lleva el server porque en DM no hay guild).
  if (accion === 'calificar') {
    const [, , guildId, valorTxt] = interaction.customId.split(':');
    const valor = Math.min(Math.max(Math.round(Number(valorTxt)) || 0, 1), 5);
    const pendiente = encuestaPendienteDe(guildId, interaction.user.id);
    if (!pendiente) {
      return interaction.reply({ content: 'Esa encuesta ya está respondida (o venció).', flags: MessageFlags.Ephemeral });
    }
    const registro = guardarCalificacion(guildId, interaction.user.id, { ...pendiente, valor });

    // El aviso va al canal de logs del server: es información para el staff.
    const guild = interaction.client.guilds?.cache?.get(guildId) ?? null;
    if (guild) {
      const raiz = getGuildConfig(guildId);
      const canalLogs = guild.channels.cache.get(configDe(guildId).canalLogs || raiz.logs || raiz.avisosChannel);
      const promedio = promedioCalificaciones(guildId);
      canalLogs
        ?.send({
          embeds: [
            brandEmbed({
              color: valor >= 4 ? COLORS.success : valor === 3 ? COLORS.info : COLORS.warn,
              title: `Ticket #${registro.numero} calificado con ${valor}/5`,
              description:
                `**Calificó:** <@${interaction.user.id}> (dueño del ticket)\n` +
                `**Atendido por:** ${registro.staffId ? `<@${registro.staffId}>` : '*nadie lo reclamó*'}` +
                (promedio === null ? '' : `\n**Promedio:** ${promedio.toFixed(1)}/5`),
            }),
          ],
        })
        .catch(() => {});
    }

    return interaction.update({ content: `¡Gracias! Quedó registrado con **${valor}/5**.`, embeds: [], components: [] });
  }
}

// Selectores de ticket: el tipo del panel abre su formulario; el motivo del cierre
// ejecuta el cierre con esa razón.
async function manejarSelectTicket(interaction) {
  if (interaction.customId === 'ticket:motivo') {
    const canal = interaction.channel;
    const duenioId = canal?.topic?.split(':')[1];
    const esDuenio = interaction.user.id === duenioId;
    if (!esDuenio && !esStaff(interaction.member)) {
      return interaction.reply({ content: 'Solo el dueño del ticket o el staff pueden cerrarlo.', flags: MessageFlags.Ephemeral });
    }
    const motivo = MOTIVOS_CIERRE.find((m) => m.valor === interaction.values?.[0]);
    if (!motivo) {
      return interaction.reply({ content: 'No reconocí ese motivo de cierre.', flags: MessageFlags.Ephemeral });
    }
    await interaction.update({ content: `Cerrando el ticket (${motivo.etiqueta})…`, embeds: [], components: [] }).catch(() => {});
    await cerrarTicket(interaction, interaction.user, { motivo: motivo.etiqueta, motivoClave: motivo.valor });
    return;
  }

  const tipo = tipoDe(interaction.values?.[0]);
  if (!tipo) {
    return interaction.reply({ content: 'No reconocí ese tipo de ticket.', flags: MessageFlags.Ephemeral });
  }
  return interaction.showModal(modalDeTipo(tipo));
}

async function manejarModalTicket(interaction) {
  const partes = interaction.customId.split(':'); // ticket:modal[:<tipo>]

  // Modal de "agregar usuario": no abre ticket, le da acceso al canal.
  if (partes[2] === 'agregar') {
    const id = String(interaction.fields.getTextInputValue('usuario')).match(/\d{17,20}/)?.[0];
    if (!id) {
      return interaction.reply({ content: '⚠️ No encontré una ID válida ahí. Copiala con clic derecho → **Copiar ID de usuario**.', flags: MessageFlags.Ephemeral });
    }
    const miembro = await interaction.guild.members.fetch(id).catch(() => null);
    if (!miembro) {
      return interaction.reply({ content: '⚠️ No pude encontrar a ese usuario en el servidor.', flags: MessageFlags.Ephemeral });
    }
    const resultado = await interaction.channel.permissionOverwrites
      .edit(id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
      })
      .then(() => null)
      .catch((error) => error);
    if (resultado) {
      return interaction.reply({ content: `⚠️ No pude darle acceso: ${resultado.message}`, flags: MessageFlags.Ephemeral });
    }
    await interaction.channel
      .send({
        embeds: [
          brandEmbed({
            color: COLORS.info,
            title: 'Usuario agregado',
            description: `${miembro} se sumó al ticket, invitado por ${interaction.user}.`,
          }),
        ],
      })
      .catch(() => {});
    return interaction.reply({ content: `Listo, ${nombreDe(miembro.user, miembro)} ya ve el ticket.`, flags: MessageFlags.Ephemeral });
  }

  const tipo = tipoDe(partes[2]) ?? tipoDe(TIPO_POR_DEFECTO);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Se guarda lo que el usuario escribió, campo por campo, con los topes del tipo.
  const campos = {};
  for (const campo of tipo.campos) {
    const valor = String(interaction.fields.getTextInputValue(campo.id) ?? '').trim();
    if (valor) campos[campo.id] = valor.slice(0, campo.max);
  }

  const resultado = await abrirTicket(interaction, { tipo: tipo.id, campos });
  if (resultado.error) {
    return interaction.editReply({ content: `⚠️ ${resultado.error}` });
  }
  await interaction.editReply({ content: `Tu ticket de **${tipo.etiqueta}** quedó abierto en ${resultado.canal}.` });
}

module.exports = {
  abrirTicket,
  cerrarTicket,
  cerrarCanal,
  procesarInactividad,
  registrarActividad,
  registrarCierre,
  estadisticasTickets,
  MOTIVOS_CIERRE,
  HORAS_INACTIVIDAD_POR_DEFECTO,
  AVISO_INACTIVIDAD_MS,
  ACTIVIDAD_MINIMA_MS,
  MAX_CIERRES,
  panel,
  configDe,
  esStaff,
  TIPOS,
  tipoDe,
  activoDe,
  marcarActivo,
  borrarActivo,
  encuestaPendienteDe,
  guardarCalificacion,
  promedioCalificaciones,
  manejarBotonTicket,
  manejarSelectTicket,
  manejarModalTicket,
  dividirTranscript,
  partesTranscriptHtml,
  escaparHtml,
  LIMITE_ADJUNTO_BYTES,
  GRACIA_MS,
};
