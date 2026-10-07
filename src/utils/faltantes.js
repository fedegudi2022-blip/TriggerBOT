// Temas que el bot NO supo contestar: la cola de trabajo de la base de conocimiento.
//
// Por qué existe: hasta ahora la negativa se perdía en el canal. La IA contestaba "eso no
// lo tengo cargado, abrí un ticket", el staff lo leía al pasar y el tema seguía faltando;
// no había forma de saber QUÉ se pregunta y no está, ni cuántas veces. El README de
// docs/conocimiento/ decía "si el bot dice que no, cargá el archivo" — pero sin la lista
// de lo que falta, esa instrucción dependía de que alguien se acordara.
//
// Acá cada negativa entra agrupada por pregunta (sin tildes ni signos: "¿Cuál es el
// horario?" y "cual es el horario" son el mismo tema) con su contador, quiénes la
// preguntaron y cuándo fue la última vez. Se ve y se administra con /faltantes.
//
// Es deliberadamente una cola acotada (MAX_TEMAS por servidor), no un archivo histórico:
// cuando se llena, se va el tema menos reciente —el que menos chances tiene de estar
// sobre la mesa— y los que más se repiten quedan arriba.
//
// Solo entran las NEGATIVAS de la IA: un turno sin IA (presupuesto agotado o todos los
// proveedores caídos) no dice nada de la base de conocimiento y no ensucia la lista; eso
// se ve en /latencias y en el aviso de presupuesto de la vigilancia.
//
// Estructura: { [guildId]: [ { clave, pregunta, veces, primera, ultima, autores, canal, modo, perfil } ] }

const fs = require('node:fs');
const path = require('node:path');
const { normalizar } = require('./conocimiento');
const { marcarSucio } = require('../db/sync');

const DATA_DIR = process.env.TRIGGER_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'faltantes.json');

const MAX_TEMAS = 60; // tope por servidor: una cola de trabajo, no un diario
const MAX_AUTORES = 5; // a quién volver a preguntar por el tema
const MAX_PREGUNTA = 200; // cómo se guarda la pregunta (se muestra recortada)

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
    console.error('[TriggerBOT] No se pudo leer data/faltantes.json, se inicia sin temas:', error.message);
    cache = {};
  }
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE); // escritura atómica: si algo falla, no se corrompe el archivo
}

// Clave de agrupación: la pregunta sin tildes, sin signos y con los espacios colapsados.
// La normalización es la misma que usa el buscador de la base, así "¿Cómo pido ayuda?"
// y "como pido ayuda" caen en el mismo tema.
function claveDe(pregunta) {
  return normalizar(pregunta)
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Registra una negativa. Agrupa por clave, suma el contador y actualiza el contexto.
// Nunca lanza: es un extra para el staff y no puede romper la respuesta del bot.
function registrar(guildId, { pregunta, usuario = null, canal = null, modo = null, perfil = null, cuando = Date.now() } = {}) {
  const texto = String(pregunta ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PREGUNTA);
  if (!guildId || !texto) return null;
  const clave = claveDe(texto);
  if (!clave) return null;

  const lista = cache[guildId] ?? (cache[guildId] = []);
  let tema = lista.find((t) => t.clave === clave);
  if (!tema) {
    tema = { clave, pregunta: texto, veces: 0, primera: cuando, ultima: cuando, autores: [], canal: null, modo: null, perfil: null };
    lista.push(tema);
    if (lista.length > MAX_TEMAS) {
      // Se va el menos reciente: el que nadie volvió a preguntar.
      const viejo = lista.reduce((a, b) => (a.ultima <= b.ultima ? a : b));
      lista.splice(lista.indexOf(viejo), 1);
    }
  }

  tema.veces += 1;
  tema.ultima = cuando;
  tema.canal = canal ?? tema.canal;
  tema.modo = modo ?? tema.modo;
  tema.perfil = perfil ?? tema.perfil;
  if (usuario && !tema.autores.includes(usuario)) {
    tema.autores.push(usuario);
    if (tema.autores.length > MAX_AUTORES) tema.autores.shift();
  }

  try {
    save();
  } catch (error) {
    console.warn(`[TriggerBOT] No pude guardar data/faltantes.json: ${error.message}`);
  }
  tocarMarca(guildId);
  marcarSucio(guildId, 'faltantes', () => cache[guildId] ?? []);
  return tema;
}

// Los temas del servidor, los más preguntados primero (y, a igualdad, el más reciente).
function listar(guildId, { limite = MAX_TEMAS } = {}) {
  const lista = [...(cache[guildId] ?? [])].sort((a, b) => b.veces - a.veces || b.ultima - a.ultima);
  return Number.isFinite(limite) ? lista.slice(0, Math.max(Math.round(limite), 0)) : lista;
}

function total(guildId) {
  return (cache[guildId] ?? []).length;
}

// Quita el tema que ocupa el puesto `numero` (1 = el primero de /faltantes ver).
// El número es el de la LISTA MOSTRADA, no el del orden de inserción: si no, borrar el
// "1" sacaría un tema distinto del que el staff está leyendo.
function olvidar(guildId, numero) {
  const ordenados = listar(guildId, { limite: Infinity });
  const puesto = Math.round(Number(numero));
  if (!Number.isFinite(puesto) || puesto < 1 || puesto > ordenados.length) return null;

  const tema = ordenados[puesto - 1];
  const lista = cache[guildId] ?? [];
  lista.splice(lista.indexOf(tema), 1);
  if (!lista.length) delete cache[guildId];

  try {
    save();
  } catch (error) {
    console.warn(`[TriggerBOT] No pude guardar data/faltantes.json: ${error.message}`);
  }
  tocarMarca(guildId);
  marcarSucio(guildId, 'faltantes', () => cache[guildId] ?? []);
  return tema;
}

function limpiar(guildId) {
  const cuantos = (cache[guildId] ?? []).length;
  delete cache[guildId];
  if (!cuantos) return 0;
  try {
    save();
  } catch (error) {
    console.warn(`[TriggerBOT] No pude guardar data/faltantes.json: ${error.message}`);
  }
  tocarMarca(guildId);
  marcarSucio(guildId, 'faltantes', () => []);
  return cuantos;
}

// ---------- Compatibilidad con el respaldo en MariaDB (db/sync.js) ----------
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
  /* acá se escribe al momento: no hay nada diferido que volcar */
}

load();
inicializarMarcas();

module.exports = { MAX_TEMAS, MAX_AUTORES, claveDe, registrar, listar, total, olvidar, limpiar, leer, escribir, marcasPorGuild, leerGuilds, volcar };
