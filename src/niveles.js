// Sistema de niveles: XP por actividad con anti-farm, curva de niveles y logros.
// Persistencia en data/niveles.json con escritura atómica (misma mecánica que store.js).
//
// XP: entre 15 y 25 por mensaje, con cooldown de 60 s por usuario (anti-farm).
// Nivel: nivel = floor(0.1 * sqrt(xp)) → el XP necesario crece cuadráticamente.
// Logros: se otorgan una sola vez al cumplir la condición.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'niveles.json');

let cache = {};

function load() {
  try {
    if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (error) {
    console.error('[TriggerBOT] No se pudo leer data/niveles.json:', error.message);
    cache = {};
  }
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
}

// ---------- XP y niveles ----------
const XP_MIN = 15;
const XP_MAX = 25;
const COOLDOWN_MS = 60_000;

function xpParaNivel(nivel) {
  return Math.ceil((nivel / 0.1) ** 2); // XP total acumulada necesaria para el nivel
}

function nivelDe(xp) {
  return Math.floor(0.1 * Math.sqrt(xp));
}

// ---------- Logros ----------
const LOGROS = [
  { id: 'primer_mensaje', nombre: 'Primer mensaje', desc: 'Enviaste tu primer mensaje', nivel: 0, cond: (s) => s.mensajes >= 1, emoji: '🌱' },
  { id: 'charlatan', nombre: 'Charlatán', desc: '100 mensajes', nivel: 0, cond: (s) => s.mensajes >= 100, emoji: '💬' },
  { id: 'veterano', nombre: 'Veterano', desc: '1.000 mensajes', nivel: 0, cond: (s) => s.mensajes >= 1000, emoji: '🏆' },
  { id: 'nivel_5', nombre: 'En racha', desc: 'Llegaste al nivel 5', nivel: 0, cond: (s, lvl) => lvl >= 5, emoji: '⭐' },
  { id: 'nivel_10', nombre: 'Experto', desc: 'Llegaste al nivel 10', nivel: 0, cond: (s, lvl) => lvl >= 10, emoji: '🌟' },
  { id: 'nivel_20', nombre: 'Leyenda', desc: 'Llegaste al nivel 20', nivel: 0, cond: (s, lvl) => lvl >= 20, emoji: '👑' },
  { id: 'semana', nombre: 'Semana activa', desc: '7 días seguidos de actividad', nivel: 0, cond: (s) => s.racha >= 7, emoji: '🔥' },
  { id: 'mes', nombre: 'Mes activo', desc: '30 días seguidos de actividad', nivel: 0, cond: (s) => s.racha >= 30, emoji: '🚀' },
];

// ---------- Acceso por guild/usuario ----------
function usuario(guildId, userId) {
  cache[guildId] = cache[guildId] || {};
  cache[guildId][userId] = cache[guildId][userId] || {
    xp: 0,
    mensajes: 0,
    nivel: 0,
    racha: 0,
    ultimoMensaje: 0,
    ultimoDia: null,
    logros: [],
  };
  return cache[guildId][userId];
}

// Procesa un mensaje: suma XP si corresponde y devuelve lo que cambió.
function procesarMensaje(guildId, userId) {
  const u = usuario(guildId, userId);
  const ahora = Date.now();

  u.mensajes += 1;

  // Racha de días activos (zona horaria de Argentina).
  const hoy = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'numeric', year: 'numeric' }).format(ahora);
  if (u.ultimoDia !== hoy) {
    const ayer = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    }).format(ahora - 86400_000);
    u.racha = u.ultimoDia === ayer ? (u.racha || 0) + 1 : 1;
    u.ultimoDia = hoy;
  }

  // XP con cooldown anti-farm.
  let xpGanado = 0;
  if (ahora - (u.ultimoMensaje || 0) >= COOLDOWN_MS) {
    xpGanado = XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
    u.xp += xpGanado;
    u.ultimoMensaje = ahora;
  }

  const nivelNuevo = nivelDe(u.xp);
  const subio = nivelNuevo > u.nivel;
  const nivelAnterior = u.nivel;
  u.nivel = nivelNuevo;
  save();

  // Logros recién cumplidos (no repetidos).
  const logrosNuevos = LOGROS.filter((l) => !u.logros.includes(l.id) && l.cond(u, nivelNuevo));
  u.logros.push(...logrosNuevos.map((l) => l.id));
  if (logrosNuevos.length) save();

  return { xpGanado, subio, nivelAnterior, nivelNuevo, logrosNuevos, totalMensajes: u.mensajes };
}

function datosDe(guildId, userId) {
  const u = cache[guildId]?.[userId];
  if (!u) return { xp: 0, mensajes: 0, nivel: 0, racha: 0, logros: [] };
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

// Config de anuncios por servidor.
function canalAnuncios(guildId) {
  return getGuildConfigSafe(guildId).canalNiveles ?? null;
}

function getGuildConfigSafe(guildId) {
  const { getGuildConfig } = require('./store');
  return getGuildConfig(guildId);
}

load();

module.exports = {
  procesarMensaje,
  datosDe,
  ranking,
  posicion,
  xpParaNivel,
  nivelDe,
  LOGROS,
  canalAnuncios,
  XP_MIN,
  XP_MAX,
};
