// Almacenamiento simple en archivo JSON (no es una base de datos).
// Guarda la configuración por servidor y sobrevive reinicios del bot.
// Estructura: { [guildId]: { welcome: {...}, autorole: ..., modlog: ... } }

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

let cache = {};

function load() {
  try {
    if (fs.existsSync(FILE)) {
      cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
  } catch (error) {
    console.error('[TriggerBOT] No se pudo leer data/config.json, se inicia con configuración vacía:', error.message);
    cache = {};
  }
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE); // escritura atómica: si algo falla, no se corrompe el archivo
}

function getGuildConfig(guildId) {
  return cache[guildId] || {};
}

function setGuildConfig(guildId, updater) {
  const guildConfig = getGuildConfig(guildId);
  updater(guildConfig);
  cache[guildId] = guildConfig;
  save();
}

load();

module.exports = { getGuildConfig, setGuildConfig };
