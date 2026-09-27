// Notas internas del staff sobre un usuario, guardadas en data/notas.json.
// A diferencia de los warns (que cuentan para el silencio automático de 3), las notas
// son observaciones que NO sancionan: "habló con el staff", "ya se le avisó", etc.
// Separarlas evita que una observación dispare una sanción.
//
// Estructura: { [guildId]: { [userId]: [ { texto, moderatorId, timestamp } ] } }

const fs = require('node:fs');
const path = require('node:path');
const { marcarSucio } = require('./db/sync');

const DATA_DIR = process.env.TRIGGER_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'notas.json');

const MAX_NOTAS = 50; // tope por usuario: una nota es para el staff, no un diario

let cache = {};

const marcasCambio = new Map();
function tocarMarca(guildId) {
  const previa = marcasCambio.get(guildId) ?? 0;
  marcasCambio.set(guildId, Math.max(previa, Date.now()));
}

function inicializarMarcas() {
  const mtime = fs.existsSync(FILE) ? fs.statSync(FILE).mtimeMs : 0;
  for (const guildId of Object.keys(cache)) marcasCambio.set(guildId, mtime);
}

function load() {
  try {
    if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (error) {
    console.error('[TriggerBOT] No se pudo leer data/notas.json, se inicia sin notas:', error.message);
    cache = {};
  }
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
}

function getNotas(guildId, userId) {
  return cache[guildId]?.[userId] ?? [];
}

// Agrega una nota y devuelve el total del usuario.
function addNota(guildId, userId, entry) {
  cache[guildId] = cache[guildId] || {};
  cache[guildId][userId] = cache[guildId][userId] || [];
  cache[guildId][userId].push(entry);
  if (cache[guildId][userId].length > MAX_NOTAS) cache[guildId][userId] = cache[guildId][userId].slice(-MAX_NOTAS);
  save();
  tocarMarca(guildId);
  marcarSucio(guildId, 'notas', () => cache[guildId] ?? {});
  return cache[guildId][userId].length;
}

// Quita la nota número `index` (empezando en 1) y la devuelve, o null si no existe.
function removeNota(guildId, userId, index) {
  const notas = cache[guildId]?.[userId];
  if (!notas || index < 1 || index > notas.length) return null;
  const [removed] = notas.splice(index - 1, 1);
  if (notas.length === 0) delete cache[guildId][userId];
  save();
  tocarMarca(guildId);
  marcarSucio(guildId, 'notas', () => cache[guildId] ?? {});
  return removed;
}

function leer(guildId) {
  return cache[guildId] ?? {};
}

function escribir(guildId, datos) {
  cache[guildId] = datos ?? {};
  save();
  tocarMarca(guildId);
}

function marcasPorGuild() {
  return Object.fromEntries(marcasCambio);
}

function leerGuilds() {
  const mtime = fs.existsSync(FILE) ? fs.statSync(FILE).mtimeMs : 0;
  const out = {};
  for (const guildId of Object.keys(cache)) out[guildId] = mtime;
  return out;
}

function volcar() {
  /* las notas se escriben siempre al momento */
}

load();
inicializarMarcas();

module.exports = { getNotas, addNota, removeNota, leer, escribir, marcasPorGuild, leerGuilds, volcar };
