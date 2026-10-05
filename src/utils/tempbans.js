// Baneos temporales: el staff pone una duración y el bot desbanea solo al vencer.
//
// El estado vive en la config del servidor (`c.tempbans`), así que sobrevive
// reinicios y viaja con el respaldo de MariaDB como cualquier otro ajuste. La
// pasada que desbanea la llama index.js cada minuto (y una vez al arrancar).
//
// Honestidad ante todo: si Discord rechaza el desbaneo, la entrada NO se borra
// (se reintenta en la próxima pasada y, tras varios intentos, se descarta
// avisando en el mod-log). Nunca se informa "desbaneado" si no se desbaneó.
// Un baneo que ya no existe (error 10026, lo levantó el staff a mano) se cuenta
// como terminado: el objetivo final está cumplido.
const { getGuildConfig, setGuildConfig } = require('../store');
const { logAction } = require('./modlog');
const { avisarPorDM } = require('./moderation');
const { COLORS } = require('./replies');
const crearLogger = require('../logger');

const log = crearLogger('tempbans');

const DURACION_MINIMA_MS = 60_000; // 1 minuto
const DURACION_MAXIMA_MS = 30 * 86400_000; // 30 días
const DURACION_POR_DEFECTO_MS = 86400_000; // 1 día
const MAX_POR_PASADA = 10; // desbaneos por guild y pasada (no golpear la API)
const MAX_INTENTOS = 5; // tras estos intentos la entrada se descarta (y se avisa)
const UNKNOWN_BAN = 10026; // Discord: ese usuario no está baneado

// "90s" | "30m" | "12h" | "7d" → milisegundos. Sin unidad se asume minutos.
// Devuelve null si el texto no es una duración o si queda fuera del rango permitido
// (ahí el comando avisa el rango en vez de recortar la duración en silencio).
function parsearDuracion(texto) {
  const limpio = String(texto ?? '')
    .trim()
    .toLowerCase();
  if (!limpio) return null;
  const partes = limpio.match(/^(\d{1,4})\s*(s|seg|segs|m|min|mins|h|hs|hora|horas|d|dia|dias|días)?$/);
  if (!partes) return null;
  const cantidad = Number(partes[1]);
  if (!Number.isFinite(cantidad) || cantidad <= 0) return null;

  const unidad = partes[2] ?? 'm';
  const factor = unidad.startsWith('s') ? 1000 : unidad.startsWith('h') ? 3600_000 : unidad.startsWith('d') ? 86400_000 : 60_000;
  const ms = cantidad * factor;
  return ms < DURACION_MINIMA_MS || ms > DURACION_MAXIMA_MS ? null : ms;
}

// 5400000 → "1 h 30 min" (como mucho dos unidades, para que entre en un embed).
function formatearDuracion(ms) {
  const totalSegundos = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(totalSegundos) || totalSegundos <= 0) return '0 min';
  if (totalSegundos < 120) return `${totalSegundos} s`;

  const dias = Math.floor(totalSegundos / 86400);
  const horas = Math.floor((totalSegundos % 86400) / 3600);
  const minutos = Math.floor((totalSegundos % 3600) / 60);
  const partes = [];
  if (dias) partes.push(`${dias} d`);
  if (horas) partes.push(`${horas} h`);
  if (minutos && !dias) partes.push(`${minutos} min`);
  return partes.slice(0, 2).join(' ') || `${Math.round(totalSegundos / 60)} min`;
}

function tempbansDe(guildId) {
  const lista = getGuildConfig(guildId).tempbans;
  return Array.isArray(lista) ? lista : [];
}

// Anota un baneo temporal pendiente (reemplaza el anterior del mismo usuario).
function programar(guildId, { userId, hasta, razon = null, moderadorId = null, casoId = null }) {
  const entrada = { userId, hasta, razon, moderadorId, casoId, desde: Date.now(), intentos: 0 };
  setGuildConfig(guildId, (c) => {
    c.tempbans = [...(c.tempbans ?? []).filter((t) => t.userId !== userId), entrada];
  });
  return entrada;
}

// Quita la entrada pendiente. Devuelve true si había algo que quitar.
function cancelar(guildId, userId) {
  let quitado = false;
  setGuildConfig(guildId, (c) => {
    const previos = c.tempbans ?? [];
    const restantes = previos.filter((t) => t.userId !== userId);
    quitado = restantes.length !== previos.length;
    if (restantes.length) c.tempbans = restantes;
    else delete c.tempbans; // sin pendientes no se guarda una lista vacía
  });
  return quitado;
}

function anotarIntento(guildId, userId, intentos, error) {
  setGuildConfig(guildId, (c) => {
    const entrada = (c.tempbans ?? []).find((t) => t.userId === userId);
    if (!entrada) return;
    entrada.intentos = intentos;
    entrada.ultimoError = error;
  });
}

// Desbanea a un usuario y cierra su entrada. Devuelve lo que REALMENTE pasó.
async function desbanear(guild, entrada) {
  const etiqueta = `${guild.id}:${entrada.userId}`;
  try {
    await guild.members.unban(entrada.userId, `Baneo temporal vencido${entrada.razon ? `: ${entrada.razon}` : ''}`);
  } catch (error) {
    if (error?.code !== UNKNOWN_BAN) {
      const intentos = (entrada.intentos ?? 0) + 1;
      if (intentos < MAX_INTENTOS) {
        anotarIntento(guild.id, entrada.userId, intentos, error.message);
        log.warn(`No pude desbanear a ${etiqueta} (intento ${intentos}/${MAX_INTENTOS}): ${error.message}`);
        return { guildId: guild.id, userId: entrada.userId, ok: false, intentos, error: error.message };
      }
      cancelar(guild.id, entrada.userId);
      logAction(guild, {
        action: 'Baneo temporal vencido — no se pudo desbanear',
        color: COLORS.warn,
        target: { id: entrada.userId, tag: entrada.userId },
        moderator: guild.client.user,
        reason: entrada.razon,
        extra: `Se intentó ${intentos} veces y Discord siguió rechazando: ${error.message}`,
      });
      return { guildId: guild.id, userId: entrada.userId, ok: false, intentos, error: error.message, descartado: true };
    }
    // Ya no estaba baneado: el objetivo está cumplido igual.
  }

  cancelar(guild.id, entrada.userId);
  const caso = logAction(guild, {
    action: 'Baneo temporal vencido (desbaneo automático)',
    color: COLORS.success,
    target: { id: entrada.userId, tag: entrada.userId },
    moderator: guild.client.user,
    reason: entrada.razon,
    duration: formatearDuracion(Date.now() - (entrada.desde ?? Date.now())),
    extra: 'Lo levantó el bot solo: no hace falta que el staff haga nada.',
  });

  const usuario = await guild.client.users?.fetch?.(entrada.userId).catch(() => null);
  if (usuario) {
    void avisarPorDM(usuario, `Tu baneo temporal en **${guild.name}** terminó. Podés volver a entrar.`);
  }

  return { guildId: guild.id, userId: entrada.userId, ok: true, caso };
}

// Pasada periódica: desbanea a todos los vencidos de todos los servers.
async function procesar(client) {
  const ahora = Date.now();
  const resultados = [];
  for (const guild of client.guilds.cache.values()) {
    const vencidos = tempbansDe(guild.id).filter((t) => Number(t.hasta) <= ahora && t.userId);
    if (!vencidos.length) continue;
    // Los más viejos primero: si hay una oleada, los que esperan hace más salen antes.
    vencidos.sort((a, b) => Number(a.hasta) - Number(b.hasta));
    for (const entrada of vencidos.slice(0, MAX_POR_PASADA)) {
      resultados.push(await desbanear(guild, entrada));
    }
  }
  return resultados;
}

module.exports = {
  parsearDuracion,
  formatearDuracion,
  tempbansDe,
  programar,
  cancelar,
  desbanear,
  procesar,
  DURACION_MINIMA_MS,
  DURACION_MAXIMA_MS,
  DURACION_POR_DEFECTO_MS,
  MAX_INTENTOS,
};
