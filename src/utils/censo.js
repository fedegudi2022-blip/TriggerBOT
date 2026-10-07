// Censo del servidor: cuánta gente hay, cuántos son bots y cuántos están en línea.
//
// Por qué existe: los canales de estadísticas (utils/estadisticasServer.js) muestran
// números que la API de Discord no entrega listos. Dos problemas concretos:
//
//   1. **Bots vs humanos**: hace falta la lista completa de miembros para descontar los
//      bots. En un servidor de 87.000 miembros eso no está en la caché.
//   2. **En línea**: solo lo puede contar el Presence Intent, y una presencia de la
//      caché solo existe para quien Discord ya avisó. Contar sobre una caché parcial
//      daría un número bajo y falso, que es peor que no mostrar nada.
//
// La solución son DOS piezas: una foto completa (`sembrar`: un fetch de miembros con
// presencias, cada 6 h y al arrancar) y, a partir de ahí, los eventos de presencia
// (`actualizarPresencia`) para mantener el número al día sin volver a descargar toda la
// lista cada 10 minutos.
//
// Todo vive en memoria a propósito: un reinicio pierde la foto y se vuelve a sembrar.

const { GatewayIntentBits } = require('discord.js');
const crearLogger = require('../logger');

const log = crearLogger('censo');

// Edad máxima de la foto antes de volver a descargar los miembros. Se pide
// `withPresences` en cada foto, así que no es barata: 6 h es el equilibrio entre
// exactitud y carga para el servidor de Discord.
const EDAD_MAXIMA_MS = 6 * 60 * 60 * 1000;

// guildId → { enLinea: Set<userId>, bots, miembros, cuando, conPresencias }
const censos = new Map();

// ¿El cliente tiene derecho a ver presencias? Sin el intent, Discord ni siquiera manda
// el estado de cada persona: cualquier conteo sería inventado.
function tienePresencias(client) {
  try {
    return Boolean(client?.options?.intents?.has?.(GatewayIntentBits.GuildPresences));
  } catch {
    return false;
  }
}

// Foto actual del servidor. `enLinea` viene en null cuando no hay con qué contarlo
// (sin intent, o sin foto todavía): quien lo muestre tiene que decir "sin dato", no 0.
function datosDe(guildId) {
  const censo = censos.get(guildId);
  if (!censo) return { enLinea: null, bots: null, miembros: null, cuando: 0, conPresencias: false };
  return {
    enLinea: censo.conPresencias ? censo.enLinea.size : null,
    bots: censo.bots,
    miembros: censo.miembros,
    cuando: censo.cuando,
    conPresencias: censo.conPresencias,
  };
}

function guardado(guildId) {
  return censos.has(guildId);
}

function edadMs(guildId) {
  const censo = censos.get(guildId);
  return censo ? Date.now() - censo.cuando : Infinity;
}

// Descarga los miembros una vez y arma la foto. Devuelve los datos o null si falló
// (sin permiso, sin red, guild sin miembros): nunca deja una foto a medias.
async function sembrar(guild) {
  const conPresencias = tienePresencias(guild.client);
  let miembros;
  try {
    // Solo se piden presencias si el intent está habilitado: pedirlas sin él devuelve la
    // lista igual, pero con el estado vacío, y esto se guardaría como "0 en línea".
    miembros = await guild.members.fetch(conPresencias ? { withPresences: true } : {});
  } catch (error) {
    log.warn(`No pude descargar los miembros de ${guild.id}: ${error.message}`);
    return null;
  }

  // Un fetch que no devuelve una colección (fakes de test, respuestas raras) no es una
  // foto: se descarta en vez de contar cualquier cosa.
  if (!miembros || typeof miembros.values !== 'function') return null;

  const enLinea = new Set();
  let bots = 0;
  let total = 0;
  for (const miembro of miembros.values()) {
    total += 1;
    if (miembro.user?.bot) {
      bots += 1;
      continue;
    }
    // `invisible` es un estado real de la API: para el resto del server es "desconectado".
    if (conPresencias && miembro.presence && miembro.presence.status && miembro.presence.status !== 'offline') {
      enLinea.add(miembro.id);
    }
  }

  censos.set(guild.id, { enLinea, bots, miembros: total, cuando: Date.now(), conPresencias });
  return datosDe(guild.id);
}

// Un cambio de presencia mantiene el número al día. Devuelve false cuando no había foto
// (arrancar a contar sobre la nada daría un total que no significa nada).
function actualizarPresencia(vieja, nueva) {
  const presencia = nueva ?? vieja;
  const guildId = presencia?.guild?.id;
  const userId = presencia?.userId;
  if (!guildId || !userId) return false;

  const censo = censos.get(guildId);
  if (!censo?.conPresencias) return false;

  if (presencia.status && presencia.status !== 'offline') censo.enLinea.add(userId);
  else censo.enLinea.delete(userId);
  return true;
}

// Alguien se fue del servidor: sacarlo del conteo sin esperar la próxima foto.
function olvidarMiembro(guildId, userId) {
  const censo = censos.get(guildId);
  if (!censo || !userId) return false;
  return censo.enLinea.delete(userId);
}

// Siembra los servidores que lo necesiten. `donde` filtra por guild (los canales de
// estadísticas solo miran los que los tienen activados: no se descarga la lista entera
// de un servidor que no va a mostrar el dato).
async function revisar(client, { maxEdadMs = EDAD_MAXIMA_MS, forzar = false, donde = null } = {}) {
  const resumen = { sembrados: 0, salteados: 0, fallidos: 0 };
  for (const guild of client?.guilds?.cache?.values() ?? []) {
    if (donde && !donde(guild)) {
      resumen.salteados += 1;
      continue;
    }
    if (!forzar && edadMs(guild.id) < maxEdadMs) {
      resumen.salteados += 1;
      continue;
    }
    const datos = await sembrar(guild);
    if (datos) resumen.sembrados += 1;
    else resumen.fallidos += 1;
  }
  return resumen;
}

// Estado para /diag y los tests. No dispara nada.
function estado() {
  return [...censos.entries()].map(([guildId, censo]) => ({
    guildId,
    enLinea: censo.conPresencias ? censo.enLinea.size : null,
    bots: censo.bots,
    miembros: censo.miembros,
    edadMs: Date.now() - censo.cuando,
    conPresencias: censo.conPresencias,
  }));
}

// Limpieza para los tests: el estado real no se reinicia en producción (un reinicio del
// proceso se lleva la memoria).
function reiniciar() {
  censos.clear();
}

module.exports = {
  tienePresencias,
  datosDe,
  guardado,
  edadMs,
  sembrar,
  actualizarPresencia,
  olvidarMiembro,
  revisar,
  estado,
  reiniciar,
  EDAD_MAXIMA_MS,
};
