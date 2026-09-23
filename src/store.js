// Almacenamiento simple en archivo JSON (no es una base de datos).
// Guarda la configuración por servidor y sobrevive reinicios del bot.
// Estructura: { [guildId]: { welcome: {...}, autorole: ..., modlog: ... } }

const fs = require('node:fs');
const path = require('node:path');
const { marcarSucio } = require('./db/sync');

// Directorio de datos configurable (TRIGGER_DATA_DIR) para tests y despliegues.
const DATA_DIR = process.env.TRIGGER_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

let cache = {};

// Marca del último cambio local POR servidor (no un mtime compartido del archivo):
// permite comparar guild-por-guild contra la nube al restaurar.
// Al arrancar se inicializa con el mtime del archivo (única referencia disponible);
// cada mutación real la actualiza con Date.now().
const marcasCambio = new Map();
function inicializarMarcas() {
  const mtime = fs.existsSync(FILE) ? fs.statSync(FILE).mtimeMs : 0;
  for (const guildId of Object.keys(cache)) marcasCambio.set(guildId, mtime);
}
function tocarMarca(guildId) {
  const previa = marcasCambio.get(guildId) ?? 0;
  marcasCambio.set(guildId, Math.max(previa, Date.now()));
}

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
  cancelarGuardadoDiferido(guildId); // el guardado inmediato ya incluye lo diferido
  tocarMarca(guildId);
  marcarSucio(guildId, 'config', () => cache[guildId] ?? {});
}

// ---------- Escritura diferida para mutaciones de alta frecuencia ----------
// El registro de canales temporales de voz cambia con cada entrada/salida: la
// mutación toca el cache AL INSTANTE (el bot nunca lee datos viejos) pero la
// escritura a disco se agrupa con debounce. Una ráfaga de gente entrando y
// saliendo = una sola escritura. MariaDB se sigue sincronizando igual
// (marcarSucio ya agrupa con su propio debounce). El apagado controlado llama
// a volcar(), así que un apagado limpio no pierde nada.
const DEBOUNCE_GUARDADO_MS = 1_500;
const guardadosDiferidos = new Map(); // guildId → timeout

function mutarYAgendar(guildId, updater) {
  const guildConfig = getGuildConfig(guildId);
  updater(guildConfig);
  cache[guildId] = guildConfig;
  tocarMarca(guildId);
  marcarSucio(guildId, 'config', () => cache[guildId] ?? {});
  clearTimeout(guardadosDiferidos.get(guildId));
  guardadosDiferidos.set(
    guildId,
    setTimeout(() => {
      guardadosDiferidos.delete(guildId);
      save();
    }, DEBOUNCE_GUARDADO_MS)
  );
}

function cancelarGuardadoDiferido(guildId) {
  clearTimeout(guardadosDiferidos.get(guildId));
  guardadosDiferidos.delete(guildId);
}

// Volcado forzado: escribe al disco lo que quedó pendiente del debounce.
// La llama el apagado controlado (db/sync → volcarTodo).
function volcar() {
  if (!guardadosDiferidos.size) return;
  for (const timer of guardadosDiferidos.values()) clearTimeout(timer);
  guardadosDiferidos.clear();
  save();
}

// ---------- Integración con la base de datos (respaldo en MariaDB) ----------
// Marca del último cambio real por servidor (la usa db/sync.js al restaurar).
function marcasPorGuild() {
  return Object.fromEntries(marcasCambio);
}

// Compatibilidad: versión vieja con mtime compartido.
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
  cancelarGuardadoDiferido(guildId);
  tocarMarca(guildId);
}

load();
inicializarMarcas();

module.exports = { getGuildConfig, setGuildConfig, mutarYAgendar, leerGuilds, marcasPorGuild, leer, escribir, volcar };
