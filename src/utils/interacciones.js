// Interacciones sociales con GIFs (nekos.best, API gratuita sin clave) y
// contadores persistentes: quién le dio cuántos besos/abrazos a quién.

const fs = require('node:fs');
const path = require('node:path');
const { marcarSucio } = require('../db/sync');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'interacciones.json');

let cache = {};

try {
  if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (error) {
  console.error('[TriggerBOT] No se pudo leer data/interacciones.json:', error.message);
  cache = {};
}

function guardar() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
}

// Catálogo de acciones: nombre del subcomando → endpoint de nekos.best + textos.
const ACCIONES = {
  beso: { endpoint: 'kiss', verbo: 'besó', texto: 'le dio un beso a', emoji: '😘' },
  abrazo: { endpoint: 'hug', verbo: 'abrazó', texto: 'abrazó a', emoji: '🤗' },
  caricia: { endpoint: 'pat', verbo: 'acarició', texto: 'acarició la cabeza de', emoji: '🫶' },
  abofetear: { endpoint: 'slap', verbo: 'abofeteó', texto: 'abofeteó a', emoji: '💥' },
  morder: { endpoint: 'bite', verbo: 'mordió', texto: 'mordió a', emoji: '🦷' },
  pellizco: { endpoint: 'poke', verbo: 'pellizcó', texto: 'pellizcó a', emoji: '👉' },
  chocar: { endpoint: 'handhold', verbo: 'chocó las manos con', texto: 'chocó los cinco con', emoji: '🙌' },
  guino: { endpoint: 'wink', verbo: 'guiñó el ojo a', texto: 'guiñó el ojo a', emoji: '😉' },
};

// Pide un GIF del endpoint. Devuelve la URL o null si falla (hay respaldo de texto).
async function traerGIF(endpoint) {
  try {
    const resp = await fetch(`https://nekos.best/api/v2/${endpoint}?amount=1`, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return null;
    const datos = await resp.json();
    return datos?.results?.[0]?.url ?? null;
  } catch {
    return null;
  }
}

// Suma 1 al contador de (quien → receptor, acción) y devuelve el total acumulado.
function contar(guildId, accion, quienId, receptorId) {
  cache[guildId] = cache[guildId] || {};
  cache[guildId][accion] = cache[guildId][accion] || {};
  const clave = `${quienId}:${receptorId}`;
  cache[guildId][accion][clave] = (cache[guildId][accion][clave] || 0) + 1;
  guardar();
  marcarSucio(guildId, 'interacciones', () => cache[guildId] ?? {});
  return cache[guildId][accion][clave];
}

// ---------- Integración con Supabase (respaldo en la nube) ----------
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
  guardar();
}

// Cuántas veces `quien` hizo la acción a `receptor` (o el total recibido si quien es null).
function total(guildId, accion, receptorId, quienId = null) {
  const mapa = cache[guildId]?.[accion] ?? {};
  if (quienId) return mapa[`${quienId}:${receptorId}`] ?? 0;
  return Object.entries(mapa).reduce((suma, [clave, valor]) => (clave.endsWith(`:${receptorId}`) ? suma + valor : suma), 0);
}

module.exports = { ACCIONES, traerGIF, contar, total, leerGuilds, leer, escribir };
