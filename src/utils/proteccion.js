// Anti-spam y anti-raid automáticos.
//
// Spam: cuenta mensajes por usuario en una ventana móvil (ej: 5 mensajes en 5 s).
//   Al superarlo, ejecuta la acción configurada y avisa al staff.
// Raid: cuenta ingresos al server en una ventana (ej: 8 joins en 60 s).
//   Siempre avisa al staff; si el staff prendió la auto-acción, expulsa o banea
//   automáticamente a los recién ingresados con cuenta nueva.
//
// Automod por contenido (misma config, se prende por filtro):
//   invitaciones (links de invitación a otros servers), enlaces (cualquier URL
//   fuera de linksPermitidos), menciones (más de mencionesMaximas o @everyone/here),
//   mayúsculas (mayusculasPorcentaje o más de letras en mayúscula) y repetidos
//   (el mismo mensaje repetidosVeces veces seguidas). Borran el mensaje, avisan
//   por DM y dejan el caso en el mod-log; no aplican castigos (eso es del anti-spam).
//
// Config por server (config.proteccion, se edita desde /config → Anti-spam y anti-raid):
//   activado, accionSpam (aviso|timeout|mute|kick|ban), accionRaid (nada|kick|ban),
//   spamMensajes, spamSegundos, raidJoins, raidSegundos, accionesRapidas,
//   filtroInvites, filtroLinks, linksPermitidos, filtroMenciones, mencionesMaximas,
//   filtroMayusculas, mayusculasPorcentaje, mayusculasMinimo, filtroRepetidos, repetidosVeces.
//
// IMPORTANTE: cada acción devuelve lo que REALMENTE hizo ({ ok, error }), nunca
// lo que intentó. Si Discord rechaza la operación, el log y la alerta lo dicen.
const { PermissionFlagsBits } = require('discord.js');
const { getGuildConfig } = require('../store');
const { brandEmbed, COLORS } = require('./replies');
const { avisarPorDM, validarAccionDelBot } = require('./moderation');
const { logAction } = require('./modlog');

const POR_DEFECTO = {
  activado: false,
  accionSpam: 'timeout',
  accionRaid: 'kick',
  spamMensajes: 5,
  spamSegundos: 5,
  raidJoins: 8,
  raidSegundos: 60,
  accionesRapidas: false,
  filtroInvites: false,
  filtroLinks: false,
  linksPermitidos: [],
  filtroMenciones: false,
  mencionesMaximas: 5,
  filtroMayusculas: false,
  mayusculasPorcentaje: 70,
  mayusculasMinimo: 12,
  filtroRepetidos: false,
  repetidosVeces: 3,
};

// Rangos de los ajustes de los filtros. Se acotan al LEER (no solo al guardar):
// la config también se edita desde la web y a mano, y un valor raro nunca debe
// hacer que el automod borre de más.
const LIMITES_FILTROS = {
  mencionesMaximas: [2, 20],
  mayusculasPorcentaje: [50, 100],
  mayusculasMinimo: [5, 50],
  repetidosVeces: [2, 10],
};
const MAX_ENLACES_PERMITIDOS = 20;

// Catálogo de filtros del automod: lo usa /config para dibujar los botones y el
// resumen de la sección (una sola lista, sin duplicar nombres en el panel).
const FILTROS = [
  { clave: 'filtroInvites', nombre: 'Invitaciones', detalle: 'links de invitación a otros servidores' },
  { clave: 'filtroLinks', nombre: 'Enlaces', detalle: 'URLs fuera de la lista de dominios permitidos' },
  { clave: 'filtroMenciones', nombre: 'Menciones', detalle: '@everyone, @here o demasiadas menciones' },
  { clave: 'filtroMayusculas', nombre: 'Mayúsculas', detalle: 'mensajes gritados (muchas mayúsculas seguidas)' },
  { clave: 'filtroRepetidos', nombre: 'Repetidos', detalle: 'el mismo mensaje varias veces seguidas' },
];
const COOLDOWN_FILTRO_MS = 30_000; // entre avisos del mismo filtro al mismo usuario
const REPETIDOS_VENTANA_MS = 60_000; // sin escribir en este rato, el contador de repetidos arranca de cero

const ETIQUETA_ACCION_SPAM = { aviso: 'Borrar mensajes', timeout: 'Timeout 10 min', mute: 'Silenciar', kick: 'Expulsar', ban: 'Banear' };
const ETIQUETA_ACCION_RAID = { nada: 'Solo alerta', kick: 'Expulsar', ban: 'Banear' };
const DURACION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos
const EDAD_CUENTA_NUEVA_MS = 7 * 86400_000; // cuenta de menos de 7 días = "nueva" para raids

function acotar(valor, [min, max], defecto) {
  const n = Math.round(Number(valor));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : defecto;
}

function configDe(guildId) {
  const crudo = { ...POR_DEFECTO, ...(getGuildConfig(guildId).proteccion || {}) };
  return {
    ...crudo,
    mencionesMaximas: acotar(crudo.mencionesMaximas, LIMITES_FILTROS.mencionesMaximas, POR_DEFECTO.mencionesMaximas),
    mayusculasPorcentaje: acotar(crudo.mayusculasPorcentaje, LIMITES_FILTROS.mayusculasPorcentaje, POR_DEFECTO.mayusculasPorcentaje),
    mayusculasMinimo: acotar(crudo.mayusculasMinimo, LIMITES_FILTROS.mayusculasMinimo, POR_DEFECTO.mayusculasMinimo),
    repetidosVeces: acotar(crudo.repetidosVeces, LIMITES_FILTROS.repetidosVeces, POR_DEFECTO.repetidosVeces),
    linksPermitidos: normalizarDominios(crudo.linksPermitidos),
  };
}

// ---------- Estado en memoria (se pierde al reiniciar: es intencional) ----------
// Spam: clave "guildId:userId" → { stamps: [ts], mensajes: [{ id, channelId }] }
const ventanaSpam = new Map();
// Raid: clave guildId → { stamps: [ts], miembros: [{ id, tag, creado }] }
const ventanaRaid = new Map();
// Anti-repetición: no volver a castigar al mismo usuario ni alertar del mismo raid cada tanto.
const castigadoHasta = new Map();
const ultimaAlertaRaid = new Map();
// Repetidos: clave "guildId:userId" → { contenido, veces, ts } (solo el último mensaje).
const ultimoMensaje = new Map();

// Tope del rango configurable de spamMensajes (3-20 en /config y en el esquema web).
// Antes era 10 fijo: con spamMensajes > 10 el umbral NUNCA se alcanzaba.
const MAX_MENSAJES_VENTANA = 20;
// Tope del rango configurable de spamSegundos (2-120): una entrada sin actividad
// dentro de esa ventana ya no puede aportar a ninguna detección.
const VENTANA_MAXIMA_MS = 120_000;
const COOLDOWN_CASTIGO_MS = 30_000; // entre castigos al mismo usuario
const COOLDOWN_ALERTA_RAID_MS = 60_000; // entre alertas de raid del mismo server
const LIMPIEZA_MIN_MS = 30_000; // como máximo una limpieza completa cada 30 s
const LIMPIEZA_FORZADA = 5000; // …salvo que el mapa ya sea enorme

// Poda ventanaSpam/castigadoHasta sin recorrer el mapa entero en cada mensaje.
// Se llama en cada mensaje (el throttle la hace barata) y en cada castigo.
let ultimaLimpieza = 0;
function limpiarViejo(ahora = Date.now()) {
  if (ahora - ultimaLimpieza < LIMPIEZA_MIN_MS && ventanaSpam.size < LIMPIEZA_FORZADA) return;
  ultimaLimpieza = ahora;
  const edadMaxima = VENTANA_MAXIMA_MS + COOLDOWN_CASTIGO_MS;
  for (const [k, v] of ventanaSpam) {
    const ultimo = v.stamps[v.stamps.length - 1];
    if (!ultimo || ahora - ultimo > edadMaxima) ventanaSpam.delete(k);
  }
  for (const [k, hasta] of castigadoHasta) if (hasta < ahora) castigadoHasta.delete(k);
  for (const [k, v] of ultimoMensaje) if (ahora - v.ts > REPETIDOS_VENTANA_MS) ultimoMensaje.delete(k);
}

// ---------- Alertas ----------
function canalDeAlertas(guild) {
  const config = getGuildConfig(guild.id);
  return guild.channels.cache.get(config.avisosChannel || config.logs || config.modlog) ?? null;
}

function alertar(guild, embed) {
  const canal = canalDeAlertas(guild);
  canal?.send({ embeds: [embed] }).catch(() => {});
}

// ---------- Acciones ----------
function puede(guild, permiso) {
  return Boolean(guild.members.me?.permissions.has(permiso));
}

// Aplica el timeout y devuelve lo que REALMENTE pasó: { ok, error }.
async function aplicarTimeout(member, razon, duracionMs = DURACION_TIMEOUT_MS) {
  const error = validarAccionDelBot(member.guild, member, PermissionFlagsBits.ModerateMembers);
  if (error) return { ok: false, error };
  try {
    await member.timeout(duracionMs, razon);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Discord rechazó el timeout: ${e.message}` };
  }
}

// Aplica el rol de mute si existe. Si NO existe, aplica timeout como fallback real
// (antes solo anunciaba el fallback sin ejecutarlo). Devuelve { ok, error, fallback }.
async function aplicarMute(member, razon) {
  const muteRole = getGuildConfig(member.guild.id).muteRole;
  const rol = member.guild.roles.cache.get(muteRole);
  if (rol) {
    const error = validarAccionDelBot(member.guild, member, PermissionFlagsBits.ManageRoles);
    if (error) return { ok: false, error };
    try {
      await member.roles.add(rol, razon);
      return { ok: true, fallback: false };
    } catch (e) {
      return { ok: false, error: `Discord rechazó asignar el rol de silenciado: ${e.message}` };
    }
  }
  // Fallback REAL: sin rol configurado → timeout de 10 minutos.
  const res = await aplicarTimeout(member, `${razon} (fallback: no hay rol de silenciado configurado)`);
  return { ...res, fallback: true };
}

async function borrarRafaga(guild, mensajes) {
  if (!puede(guild, PermissionFlagsBits.ManageMessages)) return 0;
  // Agrupa por canal: bulkDelete falla entero si algún mensaje tiene más de 14 días,
  // así que cada canal va con su propio lote y con force=true borra de a uno si hace falta.
  let borrados = 0;
  const porCanal = new Map();
  for (const m of mensajes) {
    if (!porCanal.has(m.channelId)) porCanal.set(m.channelId, []);
    porCanal.get(m.channelId).push(m.id);
  }
  for (const [canalId, ids] of porCanal) {
    const canal = guild.channels.cache.get(canalId);
    if (!canal?.bulkDelete) continue;
    const ok = await canal.bulkDelete(ids, true).catch(() => null);
    if (ok) borrados += ok.size;
  }
  return borrados;
}

// Ejecuta la acción configurada sobre el miembro. Devuelve un texto con lo que
// REALMENTE hizo (con ⚠️ y el motivo si Discord rechazó la operación).
async function ejecutarAccion(member, accion, razon, tipo) {
  const guild = member.guild;
  const resultado = [];

  if (accion === 'timeout') {
    const res = await aplicarTimeout(member, razon);
    resultado.push(res.ok ? 'timeout de 10 min' : `⚠️ timeout falló: ${res.error}`);
  } else if (accion === 'mute') {
    const res = await aplicarMute(member, razon);
    if (res.ok) resultado.push(res.fallback ? '⚠️ sin rol de silenciado: apliqué timeout de 10 min' : 'silenciado con rol');
    else resultado.push(`⚠️ mute falló: ${res.error}`);
  } else if (accion === 'kick') {
    const error = validarAccionDelBot(guild, member, PermissionFlagsBits.KickMembers);
    if (error) resultado.push(`⚠️ expulsión rechazada: ${error}`);
    else {
      await avisarPorDM(member.user, `Fuiste expulsado automáticamente de **${guild.name}**: ${razon}`);
      try {
        await member.kick(razon);
        resultado.push('expulsado');
      } catch (e) {
        resultado.push(`⚠️ Discord rechazó la expulsión: ${e.message}`);
      }
    }
  } else if (accion === 'ban') {
    const error = validarAccionDelBot(guild, member, PermissionFlagsBits.BanMembers);
    if (error) resultado.push(`⚠️ baneo rechazado: ${error}`);
    else {
      try {
        await member.ban({ reason: razon, deleteMessageSeconds: 3600 });
        resultado.push('baneado');
      } catch (e) {
        resultado.push(`⚠️ Discord rechazó el baneo: ${e.message}`);
      }
    }
  }

  logAction(guild, {
    action: tipo === 'spam' ? 'Anti-spam automático' : 'Anti-raid automático',
    color: tipo === 'spam' ? COLORS.warn : COLORS.error,
    target: member.user,
    moderator: guild.client.user,
    reason: razon,
    extra: `Acción automática (${accion}): ${resultado.join(', ') || 'solo alerta'}.`,
  });

  return resultado.join(', ') || 'solo alerta';
}

// ---------- Automod: filtros de contenido ----------
// Se ejecutan en cada mensaje ANTES del anti-spam. Si un filtro actúa, el mensaje se
// borra y el evento no sigue: no suma XP ni dispara la IA. No sancionan (eso es del
// anti-spam): solo sacan el mensaje de circulación y dejan constancia para el staff.
const RE_INVITACION = /(?:discord(?:app)?\.com\/invite\/|discord\.me\/|discord\.gg\/)[a-z0-9-]{2,}/i;
const RE_URL = /(?:https?:\/\/|www\.)([a-z0-9.-]+\.[a-z]{2,})(?:\/[^\s]*)?/gi;
const RE_LETRAS = /[a-záéíóúüñ]/gi;

function dominioDe(host) {
  return String(host)
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^\*\./, '');
}

// Normaliza la lista de dominios permitidos: minúsculas, sin "www." ni "*.",
// sin repetidos y con tope. Un dominio permitido también cubre sus subdominios.
function normalizarDominios(lista) {
  if (!Array.isArray(lista)) return [];
  const limpios = lista.map((d) => dominioDe(d)).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
  return [...new Set(limpios)].slice(0, MAX_ENLACES_PERMITIDOS);
}

// Devuelve el dominio del primer enlace que NO está permitido (null si no hay
// enlaces o si todos los que hay están en la lista).
function enlaceNoPermitido(contenido, permitidos) {
  for (const [, host] of contenido.matchAll(RE_URL)) {
    const dominio = dominioDe(host);
    if (permitidos.some((p) => dominio === p || dominio.endsWith(`.${p}`))) continue;
    return dominio;
  }
  return null;
}

// Porcentaje de letras en mayúscula (los números, emojis y símbolos no cuentan).
function porcentajeMayusculas(contenido) {
  const letras = contenido.match(RE_LETRAS) ?? [];
  if (!letras.length) return 0;
  const mayusculas = letras.filter((letra) => letra === letra.toUpperCase()).length;
  return Math.round((mayusculas / letras.length) * 100);
}

// @everyone/@here siempre cuenta como mención masiva; el resto, por encima del máximo.
function mencionesExcesivas(message, maximo) {
  if (message.mentions?.everyone) return '@everyone/@here';
  const total = (message.mentions?.users?.size ?? 0) + (message.mentions?.roles?.size ?? 0);
  return total > maximo ? `${total} menciones` : null;
}

function normalizarContenido(texto) {
  return texto
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cuenta mensajes CONSECUTIVOS iguales del mismo usuario. Devuelve true al llegar al
// umbral (y reinicia el contador para que el siguiente igual no vuelva a disparar).
function mensajeRepetido(message, veces) {
  const contenido = normalizarContenido(String(message.content ?? ''));
  if (!contenido) return false; // solo adjuntos, stickers o embeds: no se evalúa
  const clave = `${message.guild.id}:${message.author.id}`;
  const ahora = Date.now();
  const previo = ultimoMensaje.get(clave);
  const sigue = previo && previo.contenido === contenido && ahora - previo.ts <= REPETIDOS_VENTANA_MS;
  const registro = sigue ? { contenido, veces: previo.veces + 1, ts: ahora } : { contenido, veces: 1, ts: ahora };
  ultimoMensaje.set(clave, registro);
  if (registro.veces < veces) return false;
  registro.veces = 0;
  return true;
}

function recortar(texto, max = 280) {
  const limpio = String(texto).trim();
  if (!limpio) return '*—*';
  return limpio.length > max ? `${limpio.slice(0, max - 1)}…` : limpio;
}

// Evalúa los filtros prendidos y devuelve lo que se detectó (vacío = mensaje limpio).
function infraccionesDe(message, config) {
  const contenido = String(message.content ?? '');
  const infracciones = [];
  if (!contenido.trim()) return infracciones;

  if (config.filtroInvites && RE_INVITACION.test(contenido)) {
    infracciones.push({ tipo: 'invitaciones', razon: 'invitación a otro servidor' });
  }
  if (config.filtroLinks) {
    const dominio = enlaceNoPermitido(contenido, config.linksPermitidos);
    if (dominio) infracciones.push({ tipo: 'enlaces', razon: `enlace no permitido: ${dominio}` });
  }
  if (config.filtroMenciones) {
    const menciones = mencionesExcesivas(message, config.mencionesMaximas);
    if (menciones) infracciones.push({ tipo: 'menciones', razon: `menciones masivas (${menciones})` });
  }
  if (config.filtroMayusculas && contenido.length >= config.mayusculasMinimo) {
    const porcentaje = porcentajeMayusculas(contenido);
    if (porcentaje >= config.mayusculasPorcentaje) infracciones.push({ tipo: 'mayusculas', razon: `mayúsculas sostenidas (${porcentaje}%)` });
  }
  if (config.filtroRepetidos && mensajeRepetido(message, config.repetidosVeces)) {
    infracciones.push({ tipo: 'repetidos', razon: `el mismo mensaje ${config.repetidosVeces} veces seguidas` });
  }

  return infracciones;
}

// Aplica el automod a un mensaje. Devuelve true si borró el mensaje (el evento corta ahí).
async function procesarMensajeParaFiltros(message) {
  const config = configDe(message.guild.id);
  if (!config.activado) return false;

  const member = message.member;
  // Mismo criterio que el anti-spam: el staff con permiso de gestionar mensajes o el
  // server no queda sujeto al automod (si no, no podría pegar un link nunca).
  if (!member || member.permissions?.has(PermissionFlagsBits.ManageMessages) || member.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    return false;
  }

  const infracciones = infraccionesDe(message, config);
  if (!infracciones.length) return false;

  const razon = infracciones.map((i) => i.razon).join(' · ');
  const pudoBorrar = puede(message.guild, PermissionFlagsBits.ManageMessages);
  const borrados = await borrarRafaga(message.guild, [{ id: message.id, channelId: message.channelId }]);
  // El texto dice lo que REALMENTE pasó, nunca lo que se intentó.
  const resultado =
    borrados > 0 ? 'mensaje borrado' : pudoBorrar ? 'el mensaje ya no estaba' : '⚠️ no pude borrar el mensaje (me falta Gestionar mensajes)';

  // Avisos (DM + alerta + caso) con cooldown POR FILTRO Y USUARIO: en una ráfaga de
  // links se borra todo, pero el staff recibe un solo aviso por minuto. El borrado
  // nunca depende de esto.
  const clave = `${message.guild.id}:${message.author.id}:${infracciones[0].tipo}`;
  const ahora = Date.now();
  if ((castigadoHasta.get(clave) ?? 0) > ahora) return true;
  castigadoHasta.set(clave, ahora + COOLDOWN_FILTRO_MS);

  await avisarPorDM(
    message.author,
    `En **${message.guild.name}** borré tu último mensaje: ${razon}.\n` +
      'Si creés que fue un error, hablá con el staff. Evitá repetirlo para no sumar sanciones.'
  );

  alertar(
    message.guild,
    brandEmbed({
      color: COLORS.warn,
      title: 'Automod — mensaje filtrado',
      description: `${member} (**${member.user.tag}**) en <#${message.channelId}>: **${razon}**.`,
      fields: [
        { name: 'Resultado', value: resultado, inline: true },
        { name: 'Mensaje', value: recortar(message.content) },
      ],
      footer: 'TriggerBOT • se prende por filtro en /config → Anti-spam y anti-raid',
    })
  );

  logAction(message.guild, {
    action: 'Automod — mensaje filtrado',
    color: COLORS.warn,
    target: message.author,
    moderator: message.guild.client.user,
    reason: razon,
    extra: `Automático: ${resultado}.`,
  });

  return true;
}

// ---------- Detección de spam (se llama en cada mensaje) ----------
// Devuelve true si se tomó una acción (para que el evento no siga procesando el mensaje).
async function procesarMensajeParaSpam(message) {
  const config = configDe(message.guild.id);
  if (!config.activado) return false;

  const member = message.member;
  // Exentos: staff con permiso de gestionar mensajes o el server. Nadie más.
  if (!member || member.permissions?.has(PermissionFlagsBits.ManageMessages) || member.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    return false;
  }

  const ahora = Date.now();
  const clave = `${message.guild.id}:${message.author.id}`;
  const ventanaMs = config.spamSegundos * 1000;
  const registro = ventanaSpam.get(clave) ?? { stamps: [], mensajes: [] };

  registro.stamps.push(ahora);
  registro.mensajes.push({ id: message.id, channelId: message.channelId });

  // Poda por ventana + tope: solo se conservan los mensajes que cuentan para el
  // umbral (los de dentro de spamSegundos). Antes se guardaban "los últimos 10" a
  // secas: con spamMensajes > 10 el umbral no se alcanzaba y la ráfaga borraba
  // mensajes de fuera de la ventana.
  const tope = Math.max(MAX_MENSAJES_VENTANA, config.spamMensajes);
  while (registro.stamps.length && (ahora - registro.stamps[0] > ventanaMs || registro.stamps.length > tope)) {
    registro.stamps.shift();
    registro.mensajes.shift();
  }
  ventanaSpam.set(clave, registro);
  limpiarViejo(ahora);

  // ¿Superó el umbral dentro de la ventana?
  const enVentana = registro.stamps;
  if (enVentana.length < config.spamMensajes) return false;
  if ((castigadoHasta.get(clave) ?? 0) > ahora) return false; // ya se lo castigó hace poco

  castigadoHasta.set(clave, ahora + COOLDOWN_CASTIGO_MS);

  const razon = `Anti-spam: ${enVentana.length} mensajes en ${config.spamSegundos} s`;
  const pudoBorrar = puede(message.guild, PermissionFlagsBits.ManageMessages);
  const borrados = await borrarRafaga(message.guild, registro.mensajes);
  // El texto refleja lo que REALMENTE pasó: si la acción se rechazó o no se pudo
  // borrar, lo dice; nunca anuncia la acción configurada como si se hubiera aplicado.
  const resultadoAccion =
    config.accionSpam === 'aviso'
      ? borrados > 0
        ? `borré ${borrados} mensaje(s)`
        : pudoBorrar
          ? 'no encontré mensajes para borrar'
          : '⚠️ no pude borrar los mensajes (me falta Gestionar mensajes)'
      : await ejecutarAccion(member, config.accionSpam, razon, 'spam');

  await avisarPorDM(
    message.author,
    `En **${message.guild.name}** se detectó que escribiste demasiado rápido (${enVentana.length} mensajes en ${config.spamSegundos} s).\n` +
      `Resultado: **${resultadoAccion}**. Escribí con calma para evitar sanciones.`
  );

  alertar(
    message.guild,
    brandEmbed({
      color: COLORS.warn,
      title: 'Anti-spam — posible flood detectado',
      description: `${member} (**${member.user.tag}**) superó el umbral: **${enVentana.length} mensajes en ${config.spamSegundos} s** en <#${message.channelId}>.`,
      fields: [
        { name: 'Acción aplicada', value: `${ETIQUETA_ACCION_SPAM[config.accionSpam]} → ${resultadoAccion}`, inline: true },
        { name: 'Mensajes borrados', value: `${borrados}`, inline: true },
      ],
      footer: 'TriggerBOT • acción automática, revisá que haya sido justa',
    })
  );

  return true;
}

// ---------- Detección de raid (se llama en cada ingreso) ----------
async function registrarIngreso(member) {
  const config = configDe(member.guild.id);
  if (!config.activado) return;

  const ahora = Date.now();
  const registro = ventanaRaid.get(member.guild.id) ?? { stamps: [], miembros: [] };

  registro.stamps.push(ahora);
  registro.miembros.push({ id: member.id, tag: member.user.tag, creado: member.user.createdTimestamp });
  if (registro.stamps.length > 50) {
    registro.stamps.shift();
    registro.miembros.shift();
  }
  ventanaRaid.set(member.guild.id, registro);

  const enVentana = registro.stamps.filter((t) => ahora - t <= config.raidSegundos * 1000);
  if (enVentana.length < config.raidJoins) return;
  if ((ultimaAlertaRaid.get(member.guild.id) ?? 0) > ahora - COOLDOWN_ALERTA_RAID_MS) return; // ya se alertó hace un momento

  ultimaAlertaRaid.set(member.guild.id, ahora);

  const recientes = registro.miembros.filter((m) => ahora - m.creado <= EDAD_CUENTA_NUEVA_MS);
  const listaMiembros = registro.miembros
    .slice(-10)
    .map((m) => `• <@${m.id}> — cuenta creada <t:${Math.floor(m.creado / 1000)}:R>${ahora - m.creado <= EDAD_CUENTA_NUEVA_MS ? ' (nueva)' : ''}`)
    .join('\n');

  // Auto-acción: solo si el staff la prendió. Apunta a las cuentas nuevas con el rol menor.
  let aplicado = 'solo alerta';
  if (config.accionesRapidas && config.accionRaid !== 'nada') {
    const resultados = [];
    let ok = 0;
    let fallos = 0;
    for (const m of registro.miembros.slice(-config.raidJoins)) {
      const objetivo = member.guild.members.cache.get(m.id);
      if (!objetivo || objetivo.user.bot) continue;
      if (ahora - objetivo.user.createdTimestamp > EDAD_CUENTA_NUEVA_MS) continue; // solo cuentas nuevas
      if (objetivo.roles.cache.size > 1) continue; // ya tiene roles: probablemente no es del raid
      const razon = `Anti-raid: ${enVentana.length} ingresos en ${config.raidSegundos} s`;
      const res = await ejecutarAccion(objetivo, config.accionRaid, razon, 'raid');
      resultados.push(res);
      if (res.startsWith('⚠️')) fallos += 1;
      else ok += 1;
    }
    aplicado = resultados.length
      ? `${config.accionRaid} aplicado a ${ok} cuenta(s) nueva(s)` + (fallos ? ` — ${fallos} rechazada(s) por Discord ⚠️` : '')
      : 'nadie calificó para auto-acción (cuentas nuevas sin roles)';
  }

  alertar(
    member.guild,
    brandEmbed({
      color: COLORS.error,
      title: 'Anti-raid — oleada de ingresos detectada',
      description:
        `**${enVentana.length} ingresos en ${config.raidSegundos} s** (${recientes.length} con cuenta de menos de 7 días).\n` +
        (aplicado === 'solo alerta' ? 'Revisá la lista y actuá manualmente si corresponde.' : `Auto-acción: **${aplicado}**.`),
      fields: [{ name: 'Últimos ingresos', value: listaMiembros.slice(0, 1000) || '*—*' }],
      footer: 'TriggerBOT • activá la auto-acción en /config → Anti-spam y anti-raid si querés que actúe solo',
    })
  );
}

// Reinicia el estado (lo usan los tests).
function resetear() {
  ventanaSpam.clear();
  ventanaRaid.clear();
  castigadoHasta.clear();
  ultimaAlertaRaid.clear();
  ultimoMensaje.clear();
  ultimaLimpieza = 0;
}

module.exports = {
  procesarMensajeParaSpam,
  procesarMensajeParaFiltros,
  registrarIngreso,
  configDe,
  resetear,
  POR_DEFECTO,
  FILTROS,
  LIMITES_FILTROS,
  ETIQUETA_ACCION_SPAM,
  ETIQUETA_ACCION_RAID,
  borrarRafaga,
  ejecutarAccion,
  aplicarMute,
  aplicarTimeout,
  normalizarDominios,
  MAX_MENSAJES_VENTANA,
  MAX_ENLACES_PERMITIDOS,
};
