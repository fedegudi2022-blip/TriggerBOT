// Historial de advertencias por servidor y usuario, guardado en data/warns.json.
// Misma mecánica que store.js: JSON simple con escritura atómica.
// Estructura: { [guildId]: { [userId]: [ { reason, moderatorId, timestamp } ] } }

const fs = require('node:fs');
const path = require('node:path');
const { marcarSucio } = require('./db/sync');

// Directorio de datos configurable (TRIGGER_DATA_DIR) para tests y despliegues.
const DATA_DIR = process.env.TRIGGER_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'warns.json');

let cache = {};

// Marca del último cambio local POR servidor (comparación guild-por-guild con la nube).
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
    if (fs.existsSync(FILE)) {
      cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
  } catch (error) {
    console.error('[TriggerBOT] No se pudo leer data/warns.json, se inicia sin historial de warns:', error.message);
    cache = {};
  }
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE); // escritura atómica: si algo falla, no se corrompe el archivo
}

// Volcado forzado (los warns ya guardan síncrono; existe por simetría con el apagado).
function volcar() {
  /* los warns se escriben siempre al momento */ }

function getWarns(guildId, userId) {
  return cache[guildId]?.[userId] ?? [];
}

// Agrega una advertencia y devuelve el total acumulado del usuario.
function addWarn(guildId, userId, entry) {
  cache[guildId] = cache[guildId] || {};
  cache[guildId][userId] = cache[guildId][userId] || [];
  cache[guildId][userId].push(entry);
  save();
  tocarMarca(guildId);
  marcarSucio(guildId, 'warns', () => cache[guildId] ?? {});
  return cache[guildId][userId].length;
}

// Quita la advertencia número `index` (empezando en 1) y la devuelve, o null si no existe.
function removeWarn(guildId, userId, index) {
  const warns = cache[guildId]?.[userId];
  if (!warns || index < 1 || index > warns.length) return null;
  const [removed] = warns.splice(index - 1, 1);
  if (warns.length === 0) delete cache[guildId][userId];
  save();
  tocarMarca(guildId);
  marcarSucio(guildId, 'warns', () => cache[guildId] ?? {});
  return removed;
}

// ---------- Integración con la base de datos (respaldo en MariaDB) ----------
// Marca del último cambio real por servidor (la usa db/sync.js al restaurar).
function marcasPorGuild() {
  return Object.fromEntries(marcasCambio);
}

function leerGuilds() {
  const mtime = fs.existsSync(FILE) ? fs.statSync(FILE).mtimeMs : 0;
  const out = {};
  for (const guildId of Object.keys(cache)) out[guildId] = mtime;
  return out;
}

function leer(guildId) {
  return cache[guildId] ?? {};
}

function escribir(guildId, datos) {
  cache[guildId] = datos ?? {};
  save();
  tocarMarca(guildId);
}

load();
inicializarMarcas();

module.exports = { getWarns, addWarn, removeWarn, leerGuilds, marcasPorGuild, leer, escribir, volcar };
