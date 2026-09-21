// Historial de advertencias por servidor y usuario, guardado en data/warns.json.
// Misma mecánica que store.js: JSON simple con escritura atómica.
// Estructura: { [guildId]: { [userId]: [ { reason, moderatorId, timestamp } ] } }

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'warns.json');

let cache = {};

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

function getWarns(guildId, userId) {
  return cache[guildId]?.[userId] ?? [];
}

// Agrega una advertencia y devuelve el total acumulado del usuario.
function addWarn(guildId, userId, entry) {
  cache[guildId] = cache[guildId] || {};
  cache[guildId][userId] = cache[guildId][userId] || [];
  cache[guildId][userId].push(entry);
  save();
  return cache[guildId][userId].length;
}

// Quita la advertencia número `index` (empezando en 1) y la devuelve, o null si no existe.
function removeWarn(guildId, userId, index) {
  const warns = cache[guildId]?.[userId];
  if (!warns || index < 1 || index > warns.length) return null;
  const [removed] = warns.splice(index - 1, 1);
  if (warns.length === 0) delete cache[guildId][userId];
  save();
  return removed;
}

load();

module.exports = { getWarns, addWarn, removeWarn };
