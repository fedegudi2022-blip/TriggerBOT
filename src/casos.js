// Registro persistente de casos de moderación, guardado en data/casos.json.
// Misma mecánica que warns.js: JSON simple con escritura atómica.
//
// Hasta ahora cada caso vivía SOLO como embed en el canal de mod-log: el número se
// guardaba en la config (`config.caso`) pero el contenido se perdía con el scroll.
// Este almacén permite consultarlos después con /casos (por número o por usuario),
// que es lo que el staff necesita para auditar una sanción.
//
// Estructura: { [guildId]: [ { numero, action, targetId, targetTag, targetRaw,
//   moderatorId, moderatorTag, reason, duration, extra, color, timestamp } ] }
// Se guarda el más nuevo al final y se conservan los últimos MAX_CASOS por servidor.

const fs = require('node:fs');
const path = require('node:path');
const { marcarSucio } = require('./db/sync');

const DATA_DIR = process.env.TRIGGER_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'casos.json');

const MAX_CASOS = 1000; // tope por servidor: acota el archivo y la memoria

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
    console.error('[TriggerBOT] No se pudo leer data/casos.json, se inicia sin historial de casos:', error.message);
    cache = {};
  }
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE); // escritura atómica
}

// Registra un caso del mod-log. Devuelve el registro guardado.
function registrar(guildId, caso) {
  cache[guildId] = cache[guildId] || [];
  cache[guildId].push(caso);
  if (cache[guildId].length > MAX_CASOS) cache[guildId] = cache[guildId].slice(-MAX_CASOS);
  save();
  tocarMarca(guildId);
  marcarSucio(guildId, 'casos', () => cache[guildId] ?? []);
  return caso;
}

// Busca un caso por su número. Devuelve el registro o null.
function obtener(guildId, numero) {
  return (cache[guildId] ?? []).find((c) => c.numero === Number(numero)) ?? null;
}

// Lista casos del servidor, del más nuevo al más viejo.
//
// Filtros opcionales (los usa /logs buscar): usuario sancionado, moderador que la
// aplicó, acción (por texto, sin distinguir mayúsculas ni tildes: sirve tanto para
// "Baneo (ban)" como para "baneo") y rango de fechas en milisegundos.
function normalizarTexto(texto) {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function listar(guildId, { usuarioId = null, moderadorId = null, accion = null, desde = null, hasta = null, limite = null } = {}) {
  let casos = [...(cache[guildId] ?? [])].reverse();
  if (usuarioId) casos = casos.filter((c) => c.targetId === usuarioId);
  if (moderadorId) casos = casos.filter((c) => c.moderatorId === moderadorId);
  if (accion) {
    const buscado = normalizarTexto(accion);
    casos = casos.filter((c) => normalizarTexto(c.action).includes(buscado));
  }
  if (desde) casos = casos.filter((c) => Number(c.timestamp) >= desde);
  if (hasta) casos = casos.filter((c) => Number(c.timestamp) <= hasta);
  return limite ? casos.slice(0, limite) : casos;
}

// Acciones distintas registradas en el servidor (alimenta el autocompletado de /logs).
function acciones(guildId) {
  return [...new Set((cache[guildId] ?? []).map((c) => c.action).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
}

function leer(guildId) {
  return cache[guildId] ?? [];
}

function escribir(guildId, datos) {
  cache[guildId] = Array.isArray(datos) ? datos : [];
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
  /* los casos se escriben siempre al momento */
}

load();
inicializarMarcas();

module.exports = { registrar, obtener, listar, acciones, leer, escribir, marcasPorGuild, leerGuilds, volcar, MAX_CASOS };
