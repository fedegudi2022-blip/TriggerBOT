// Presupuesto diario de IA: cuántas respuestas puede pedirle el bot a Groq/Gemini por día.
//
// Por qué existe: los planes gratuitos tienen cuota diaria, y el cooldown de 3 s por
// mención no alcanza — una ráfaga de diez personas (o alguien insistiendo con menciones)
// se come la cuota del día y el bot queda **sin IA justo cuando más se la necesita**.
// Con el tope, el bot degrada a su repertorio local de forma previsible y el staff se
// entera por el canal de avisos (ver utils/vigilancia.js → revisarPresupuesto).
//
// Cómo cuenta:
//   · un contador por servidor y por día (el día corta a medianoche de Argentina, no en
//     UTC: si no, el contador se reiniciaría a las 21 h);
//   · en memoria, para no golpear la base en cada mensaje;
//   · con volcado diferido a `bot_stats` (tabla que ya existe, sin esquema nuevo) para
//     que un reinicio del bot no regale presupuesto nuevo.
//
// Sin cuenta en la base o sin permiso de escritura el bot sigue funcionando igual: el
// contador vive en memoria y se pierde con el reinicio (nunca rompe la charla).

const LIMITE_POR_DEFECTO = 300;
const CLAVE_STAT = 'ia_uso';
const VOLCADO_MS = 15_000;

const usos = new Map(); // guildId → { dia, usadas, avisado }
let timerVolcado = null;

// Límite configurable por variable de entorno (ver .env.example). Un valor inválido o
// vacío cae al default en vez de dejar al bot sin presupuesto o sin límite.
function limiteDiario() {
  const crudo = Number(process.env.IA_LIMITE_DIARIO);
  return Number.isFinite(crudo) && crudo > 0 ? Math.floor(crudo) : LIMITE_POR_DEFECTO;
}

// Día en curso en hora de Argentina ('en-CA' da YYYY-MM-DD, que ordena solo).
function diaDeHoy(ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(ahora);
}

function registroDe(guildId, dia = diaDeHoy()) {
  const clave = String(guildId ?? 'global');
  const actual = usos.get(clave);
  if (actual && actual.dia === dia) return actual;
  // Día nuevo: el contador arranca de cero y el aviso se vuelve a habilitar.
  const nuevo = { dia, usadas: 0, avisado: false };
  usos.set(clave, nuevo);
  return nuevo;
}

// Estado del presupuesto: usadas, límite y cuánto queda. Lo usan /status y /diag.
function estadoDe(guildId) {
  const registro = registroDe(guildId);
  const limite = limiteDiario();
  return {
    guildId: String(guildId ?? 'global'),
    dia: registro.dia,
    usadas: registro.usadas,
    limite,
    restantes: Math.max(limite - registro.usadas, 0),
    agotado: registro.usadas >= limite,
  };
}

function hayCupo(guildId) {
  return !estadoDe(guildId).agotado;
}

// Consume una respuesta del presupuesto. Devuelve false cuando no queda cupo: el que
// llama tiene que seguir sin IA (nunca tirar un error: el bot no se queda mudo).
function consumir(guildId) {
  const estado = estadoDe(guildId);
  if (estado.agotado) {
    const registro = registroDe(guildId);
    if (!registro.avisado) {
      registro.avisado = true;
      console.warn(
        `[TriggerBOT] IA: presupuesto diario agotado (${estado.limite} respuestas el ${estado.dia}). ` +
          'Hasta mañana el bot contesta con su repertorio local. Subí IA_LIMITE_DIARIO para ampliarlo.'
      );
    }
    return false;
  }
  registroDe(guildId).usadas += 1;
  agendarVolcado();
  return true;
}

// ---------- Persistencia (bot_stats) ----------
function agendarVolcado() {
  if (timerVolcado) return;
  timerVolcado = setTimeout(() => {
    timerVolcado = null;
    volcar().catch(() => {});
  }, VOLCADO_MS);
  timerVolcado.unref?.();
}

function foto() {
  const dia = diaDeHoy();
  const porGuild = {};
  for (const [guildId, registro] of usos) {
    if (registro.dia === dia) porGuild[guildId] = registro.usadas;
  }
  return { dia, porGuild, limite: limiteDiario() };
}

// Sube el contador del día a bot_stats (una sola fila para todos los servidores).
async function volcar() {
  try {
    const db = require('../db/mariadb');
    if (!db.configurada || typeof db.guardarStat !== 'function') return false;
    return await db.guardarStat(CLAVE_STAT, foto());
  } catch {
    return false;
  }
}

// Restaura el contador del día al arrancar: sin esto, cada reinicio regala el cupo
// completo (el bot se reinicia en cada deploy).
async function restaurar() {
  try {
    const db = require('../db/mariadb');
    if (!db.configurada || typeof db.listarTabla !== 'function') return false;
    const filas = await db.listarTabla('bot_stats', { filtros: { clave: CLAVE_STAT }, limite: 1 });
    const valor = filas?.[0]?.valor;
    if (!valor || valor.dia !== diaDeHoy()) return false;
    for (const [guildId, usadas] of Object.entries(valor.porGuild ?? {})) {
      usos.set(String(guildId), { dia: valor.dia, usadas: Number(usadas) || 0, avisado: false });
    }
    console.log(
      `[TriggerBOT] IA: presupuesto del día restaurado (${Object.values(valor.porGuild ?? {}).reduce((a, b) => a + Number(b || 0), 0)} respuestas usadas).`
    );
    return true;
  } catch {
    return false;
  }
}

// Vacía el contador (tests y reinicio manual del staff).
function reiniciar(guildId) {
  if (guildId === undefined) usos.clear();
  else usos.delete(String(guildId));
}

module.exports = {
  estadoDe,
  hayCupo,
  consumir,
  restaurar,
  volcar,
  reiniciar,
  foto,
  diaDeHoy,
  limiteDiario,
  LIMITE_POR_DEFECTO,
  CLAVE_STAT,
};
