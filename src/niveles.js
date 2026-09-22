// Sistema de niveles: XP por actividad con anti-farm, bonus, curva de niveles y logros.
// Persistencia en data/niveles.json con escritura atómica y DEBOUNCE: los cambios
// quedan en memoria y se escriben a disco cada 5 s (o al apagar), no en cada mensaje.
//
// XP base: entre 15 y 25 por mensaje, con cooldown de 60 s por usuario (anti-farm).
// Bonus acumulables:
//   - Racha de días activos: +1% por día, hasta +35%
//   - Fin de semana (sáb/dom, hora argentina): x2
//   - Búho nocturno (00:00-06:00): +10%
// Nivel: nivel = floor(0.1 * sqrt(xp)) → el XP necesario crece cuadráticamente.
// Logros: 16 en total, desbloqueables una sola vez, con recompensa de XP.

const fs = require('node:fs');
const path = require('node:path');
const { marcarSucio, tocar } = require('./db/sync');

// Directorio de datos configurable (TRIGGER_DATA_DIR) para tests y despliegues.
const DATA_DIR = process.env.TRIGGER_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'niveles.json');

// Debounce de escritura: el event loop no se bloquea en cada mensaje.
const GUARDADO_DEBOUNCE_MS = 5_000;
let sucio = false;
let timerGuardado = null;

let cache = {};

// Marca del último cambio local POR servidor (comparación guild-por-guild con la nube).
// Al arrancar usa el mtime del archivo; cada mutación la actualiza con Date.now().
const marcasCambio = new Map();
function tocarMarca(guildId) {
  const previa = marcasCambio.get(guildId) ?? 0;
  marcasCambio.set(guildId, Math.max(previa, Date.now()));
}

// Al arrancar: si el archivo existía, cada guild hereda su mtime como marca base.
function inicializarMarcas() {
  const mtime = fs.existsSync(FILE) ? fs.statSync(FILE).mtimeMs : 0;
  for (const guildId of Object.keys(cache)) marcasCambio.set(guildId, mtime);
}

function load() {
  try {
    if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (error) {
    console.error('[TriggerBOT] No se pudo leer data/niveles.json:', error.message);
    cache = {};
  }
}

// Escritura atómica inmediata (tmp + rename).
function guardarAhora() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
  sucio = false;
}

// Programa un guardado con debounce; evita escribir en cada mensaje.
function programarGuardado() {
  sucio = true;
  if (timerGuardado) return;
  timerGuardado = setTimeout(() => {
    timerGuardado = null;
    if (sucio) {
      try {
        guardarAhora();
      } catch (error) {
        console.error('[TriggerBOT] No se pudo guardar data/niveles.json:', error.message);
      }
    }
  }, GUARDADO_DEBOUNCE_MS);
  timerGuardado.unref?.();
}

// Volcado forzado (lo llama el apagado controlado).
function volcar() {
  if (timerGuardado) {
    clearTimeout(timerGuardado);
    timerGuardado = null;
  }
  if (sucio) {
    try {
      guardarAhora();
    } catch (error) {
      console.error('[TriggerBOT] No se pudo volcar data/niveles.json:', error.message);
    }
  }
}

// ---------- XP y niveles ----------
const XP_MIN = 15;
const XP_MAX = 25;
const COOLDOWN_MS = 60_000;

// Bonus configurables (en porcentaje).
const BONO_RACHA_MAX = 35; // +1% por día de racha, tope 35%
const BONO_NOCHE = 10; // de 00:00 a 06:00 (Argentina)
const MULT_FINDE = 2; // sábados y domingos: doble XP

function xpParaNivel(nivel) {
  return Math.ceil((nivel / 0.1) ** 2); // XP total acumulada necesaria para el nivel
}

function nivelDe(xp) {
  return Math.floor(0.1 * Math.sqrt(xp));
}

// ---------- Rangos por nivel (para /estadisticas y anuncios) ----------
const RANGOS = [
  { desde: 30, nombre: 'Leyenda', color: 0xf1c40f },
  { desde: 20, nombre: 'Veterano', color: 0x9b59b6 },
  { desde: 10, nombre: 'Experto', color: 0x57f287 },
  { desde: 5, nombre: 'Activo', color: 0x5865f2 },
  { desde: 0, nombre: 'Novato', color: 0x99aab5 },
];

function rangoDe(nivel) {
  return RANGOS.find((r) => nivel >= r.desde) ?? RANGOS[RANGOS.length - 1];
}

// ---------- Helpers de fecha (zona Argentina) ----------
const FORMATO_DIA = { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'numeric', year: 'numeric' };

function diaArg(fecha) {
  return new Intl.DateTimeFormat('es-AR', FORMATO_DIA).format(fecha);
}

function horaArg(fecha) {
  return Number(new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).format(fecha));
}

function esFinde(fecha) {
  const dia = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short' }).format(fecha);
  return dia === 'Sat' || dia === 'Sun';
}

// Multiplicador total por bonus del usuario (lo usan anuncios y /estadisticas).
function multiplicador(racha, fecha = new Date()) {
  const partes = [];
  const bonoRacha = Math.min(racha || 0, BONO_RACHA_MAX);
  if (bonoRacha > 0) partes.push(`+${bonoRacha}% racha`);
  const noche = horaArg(fecha) < 6;
  if (noche) partes.push(`+${BONO_NOCHE}% nocturno`);
  const finde = esFinde(fecha);
  if (finde) partes.push('x2 finde');
  const total = 1 + bonoRacha / 100 + (noche ? BONO_NOCHE / 100 : 0) + (finde ? MULT_FINDE - 1 : 0);
  return { total, partes, finde, noche };
}

// ---------- Logros (con recompensa de XP) ----------
// Cada logro puede llevar `meta: { campo, objetivo }` con la estadística que mide,
// para que /logros pueda mostrar barra de progreso y cuánto falta. Los logros de
// "una sola vez" (madrugador, búho) no llevan meta: no tienen progreso acumulable.
const LOGROS = [
  { id: 'primer_mensaje', nombre: 'Primer mensaje', desc: 'Enviaste tu primer mensaje', emoji: '🌱', premio: 50, meta: { campo: 'mensajes', objetivo: 1 }, cond: (s) => s.mensajes >= 1 },
  { id: 'racha_3', nombre: 'Racha inicial', desc: '3 días seguidos de actividad', emoji: '⚡', premio: 100, meta: { campo: 'racha', objetivo: 3 }, cond: (s) => s.racha >= 3 },
  { id: 'madrugador', nombre: 'Madrugador', desc: 'Escribiste entre las 6 y las 9 de la mañana', emoji: '🌅', premio: 100, cond: (s, lvl, ctx) => ctx.hora >= 6 && ctx.hora < 9 },
  { id: 'buho', nombre: 'Búho nocturno', desc: 'Escribiste entre las 00 y las 5 de la mañana', emoji: '🦉', premio: 150, cond: (s, lvl, ctx) => ctx.hora < 6 },
  { id: 'charlatan', nombre: 'Charlatán', desc: '100 mensajes', emoji: '💬', premio: 200, meta: { campo: 'mensajes', objetivo: 100 }, cond: (s) => s.mensajes >= 100 },
  { id: 'finde', nombre: 'Alma de finde', desc: '50 mensajes en fines de semana', emoji: '🎉', premio: 250, meta: { campo: 'findes', objetivo: 50 }, cond: (s) => (s.findes || 0) >= 50 },
  { id: 'nivel_5', nombre: 'En racha', desc: 'Llegaste al nivel 5', emoji: '⭐', premio: 300, meta: { campo: 'nivel', objetivo: 5 }, cond: (s, lvl) => lvl >= 5 },
  { id: 'semana', nombre: 'Semana activa', desc: '7 días seguidos de actividad', emoji: '🔥', premio: 400, meta: { campo: 'racha', objetivo: 7 }, cond: (s) => s.racha >= 7 },
  { id: 'nivel_10', nombre: 'Experto', desc: 'Llegaste al nivel 10', emoji: '🌟', premio: 600, meta: { campo: 'nivel', objetivo: 10 }, cond: (s, lvl) => lvl >= 10 },
  { id: 'conversador', nombre: 'Conversador', desc: '500 mensajes', emoji: '🗣️', premio: 800, meta: { campo: 'mensajes', objetivo: 500 }, cond: (s) => s.mensajes >= 500 },
  { id: 'veterano', nombre: 'Veterano', desc: '1.000 mensajes', emoji: '🏆', premio: 1200, meta: { campo: 'mensajes', objetivo: 1000 }, cond: (s) => s.mensajes >= 1000 },
  { id: 'xp_1000', nombre: 'Colecionista', desc: 'Acumulaste 1.000 XP', emoji: '💎', premio: 250, meta: { campo: 'xp', objetivo: 1000 }, cond: (s) => s.xp >= 1000 },
  { id: 'mes', nombre: 'Mes activo', desc: '30 días seguidos de actividad', emoji: '🚀', premio: 1500, meta: { campo: 'racha', objetivo: 30 }, cond: (s) => s.racha >= 30 },
  { id: 'nivel_20', nombre: 'Leyenda del chat', desc: 'Llegaste al nivel 20', emoji: '👑', premio: 2000, meta: { campo: 'nivel', objetivo: 20 }, cond: (s, lvl) => lvl >= 20 },
  { id: 'xp_10000', nombre: 'Diez mil', desc: 'Acumulaste 10.000 XP', emoji: '💠', premio: 1000, meta: { campo: 'xp', objetivo: 10000 }, cond: (s) => s.xp >= 10000 },
  { id: 'mito', nombre: 'Mito', desc: '5.000 mensajes', emoji: '🐐', premio: 3000, meta: { campo: 'mensajes', objetivo: 5000 }, cond: (s) => s.mensajes >= 5000 },
];

// ---------- Acceso por guild/usuario ----------
function usuario(guildId, userId) {
  cache[guildId] = cache[guildId] || {};
  cache[guildId][userId] = cache[guildId][userId] || {
    xp: 0,
    mensajes: 0,
    findes: 0,
    nivel: 0,
    racha: 0,
    ultimoMensaje: 0,
    ultimoDia: null,
    logros: [],
  };
  return cache[guildId][userId];
}

// Procesa un mensaje: suma XP con bonus, paga logros nuevos y devuelve lo que cambió.
// NO escribe a disco en cada mensaje: deja el cambio en memoria (debounce de guardado)
// y solo agenda subida a Supabase cuando hubo datos nuevos para ese guild.
function procesarMensaje(guildId, userId, fecha = new Date()) {
  const u = usuario(guildId, userId);
  const ahora = fecha.getTime();

  u.mensajes += 1;
  const hora = horaArg(fecha);
  if (esFinde(fecha)) u.findes = (u.findes || 0) + 1;

  // Racha de días activos (zona horaria de Argentina).
  if (u.ultimoDia !== diaArg(fecha)) {
    const ayer = diaArg(new Date(ahora - 86400_000));
    u.racha = u.ultimoDia === ayer ? (u.racha || 0) + 1 : 1;
    u.ultimoDia = diaArg(fecha);
  }

  // XP base con cooldown anti-farm, más bonus acumulables.
  let xpBase = 0;
  let detalle = null;
  if (ahora - (u.ultimoMensaje || 0) >= COOLDOWN_MS) {
    xpBase = XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
    const bono = multiplicador(u.racha, fecha);
    const total = Math.round(xpBase * bono.total);
    detalle = {
      base: xpBase,
      bonoRacha: Math.min(u.racha || 0, BONO_RACHA_MAX),
      finde: bono.finde,
      noche: bono.noche,
      total,
    };
    u.xp += total;
    u.ultimoMensaje = ahora;
  }

  let nivelNuevo = nivelDe(u.xp);
  const nivelAnterior = u.nivel;
  u.nivel = nivelNuevo;
  const subio = nivelNuevo > nivelAnterior;

  // Logros recién cumplidos (no repetidos) con contexto para las condiciones.
  const ctx = { hora };
  const logrosNuevos = LOGROS.filter((l) => !u.logros.includes(l.id) && l.cond(u, nivelNuevo, ctx));
  u.logros.push(...logrosNuevos.map((l) => l.id));

  // Recompensas de XP por logros: se pagan al instante y pueden hacer subir de nivel.
  const premioTotal = logrosNuevos.reduce((suma, l) => suma + (l.premio || 0), 0);
  if (premioTotal > 0) {
    u.xp += premioTotal;
    nivelNuevo = nivelDe(u.xp);
    if (nivelNuevo > u.nivel) {
      u.nivel = nivelNuevo;
      // Puede que el premio habilite más logros por nivel (ej: nivel_5). Una pasada más:
      const extra = LOGROS.filter((l) => !u.logros.includes(l.id) && l.cond(u, nivelNuevo, ctx));
      u.logros.push(...extra.map((l) => l.id));
      logrosNuevos.push(...extra);
    }
  }

  // Persistencia diferida: disco con debounce, nube con debounce propio de sync.js.
  programarGuardado();
  tocarMarca(guildId);
  tocar(guildId, 'niveles');
  marcarSucio(guildId, 'niveles', () => cache[guildId] ?? {});

  return {
    xpGanado: (detalle?.total || 0) + premioTotal,
    detalle,
    premioTotal,
    subio,
    nivelAnterior,
    nivelNuevo,
    logrosNuevos,
    totalMensajes: u.mensajes,
  };
}

function datosDe(guildId, userId) {
  const u = cache[guildId]?.[userId];
  if (!u) return { xp: 0, mensajes: 0, findes: 0, nivel: 0, racha: 0, logros: [] };
  return { ...u, logros: [...(u.logros ?? [])] };
}

// Ranking del servidor por XP.
function ranking(guildId, limite = 10) {
  const guild = cache[guildId] || {};
  return Object.entries(guild)
    .map(([userId, datos]) => ({ userId, xp: datos.xp, nivel: datos.nivel, mensajes: datos.mensajes }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, limite);
}

// Posición de un usuario en el ranking (1 = primero).
function posicion(guildId, userId) {
  const lista = ranking(guildId, 9999);
  return lista.findIndex((e) => e.userId === userId) + 1;
}

// Cantidad total de usuarios con actividad registrada en el server.
function totalUsuarios(guildId) {
  return Object.keys(cache[guildId] || {}).length;
}

// Config de anuncios por servidor.
function canalAnuncios(guildId) {
  return getGuildConfigSafe(guildId).canalNiveles ?? null;
}

function getGuildConfigSafe(guildId) {
  const { getGuildConfig } = require('./store');
  return getGuildConfig(guildId);
}

// ---------- Integración con Supabase (respaldo en la nube) ----------
// Marca de tiempo del último cambio real POR servidor (la usa db/sync.js).
function marcasPorGuild() {
  return Object.fromEntries(marcasCambio);
}

function leer(guildId) {
  return cache[guildId] ?? {};
}

function escribir(guildId, datos) {
  cache[guildId] = datos ?? {};
  guardarAhora();
  tocarMarca(guildId);
  tocar(guildId, 'niveles');
}

load();
inicializarMarcas();

module.exports = {
  procesarMensaje,
  datosDe,
  ranking,
  posicion,
  totalUsuarios,
  xpParaNivel,
  nivelDe,
  rangoDe,
  multiplicador,
  esFinde,
  LOGROS,
  RANGOS,
  canalAnuncios,
  XP_MIN,
  XP_MAX,
  marcasPorGuild,
  leer,
  escribir,
  volcar,
};
