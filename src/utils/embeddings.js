// Embeddings para la búsqueda semántica de la base de conocimiento.
//
// Por qué existe: el buscador de la base (utils/conocimiento.js) es BM25 — un algoritmo
// de palabras. Encuentra "banear" desde "baneo" porque comparten raíz, pero no encuentra
// el tema cuando la pregunta usa otras palabras: "cómo hago para que no me lleguen
// mensajes" no matchea con una sección titulada "Rol Silenciado". Con vectores, la
// pregunta y la sección se comparan por significado y esa distancia desaparece.
//
// Cómo, sin dependencias nuevas: Gemini (la misma clave que ya usa el chat) expone un
// endpoint de embeddings en su nivel gratuito y se llama con el fetch nativo, igual que
// el resto de los proveedores. Cada tanto se puede elegir otro modelo con
// GEMINI_EMBED_MODEL; por defecto se prueban los nombres estables en orden.
//
// Cuatro decisiones que hacen que esto nunca pueda romper el bot:
//   1. SIN CLAVE (o con KB_SEMANTICO=off, o con el proveedor caído) todo sigue como hoy:
//      la búsqueda semántica es una mejora, jamás un requisito. La clave es de Gemini
//      porque es la única de la cadena con embeddings gratuitos.
//   2. Los vectores de los textos son deterministas, así que se cachean en disco
//      (data/embeddings.json): un reinicio no vuelve a pagar los ~50 embeddings de la
//      base, y un .md editado solo re-embebe SU sección (la clave es el hash del texto).
//   3. Memoria de fallos, igual que utils/ia.js: un 429/5xx castiga un minuto y una clave
//      inválida una hora. Sin esto, cada pregunta pagaba un viaje de red fallido.
//   4. Todo error se devuelve como `null`, nunca como excepción: el que llama (el
//      buscador) simplemente se queda con BM25.
//
// Es un dato DERIVADO: si el archivo de caché se borra, se regenera solo. No va al
// respaldo de MariaDB (no aporta nada que no se pueda recalcular) y no toca el
// presupuesto diario de IA: no es una respuesta, es una consulta de índice.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.TRIGGER_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'embeddings.json');

const API = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 8_000;
const LOTE = 50; // textos por request (batchEmbedContents): la base entera entra en una
const MAX_TEXTO = 2_000; // caracteres por texto; una sección es de ~1.200 + título
const MAX_CONSULTAS = 500; // caché de preguntas en memoria (no se persiste: se recalculan)
const TTL_CONSULTA_MS = 60 * 60 * 1000;

// Nombres estables, del más nuevo al más viejo: si el primero no existe (404) se prueba
// el siguiente y se recuerda cuál funcionó. GEMINI_EMBED_MODEL fuerza uno solo.
const MODELOS_POR_DEFECTO = ['gemini-embedding-001', 'text-embedding-004', 'embedding-001'];

// Castigos por tipo de error (mismo criterio que utils/ia.js).
const CASTIGO_ERROR_MS = 60 * 1000; // 429, 5xx, red
const CASTIGO_CLAVE_MS = 60 * 60 * 1000; // 401/403: la clave no sirve para embeddings
const CASTIGO_TAREA_MS = 30 * 60 * 1000; // respuestas raras (400 sin explicación)

let fetchImpl = (...args) => fetch(...args);
let vectores = new Map(); // hash del texto → vector (documentos; se persiste)
const consultas = new Map(); // hash → { vector, cuando } (preguntas; en memoria)
let modelo = null; // el que respondió bien por última vez
let candidato = 0; // posición en MODELOS_POR_DEFECTO cuando todavía no hay modelo
let sinTaskType = false; // el modelo no acepta taskType: se manda sin él
let castigadoHasta = 0;
let motivoCastigo = null;
let cacheCargada = false;

// ---------- Utilidades ----------
// Hash FNV-1a de 32 bits + largo: alcanza para cachear vectores (una colisión
// devolvería un vector ajeno, así que el largo también entra en la clave).
function hashDe(texto) {
  const t = String(texto ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i += 1) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${t.length}`;
}

function recortar(texto) {
  const t = String(texto ?? '').trim();
  return t.length > MAX_TEXTO ? t.slice(0, MAX_TEXTO) : t;
}

// Similitud coseno: 1 = mismo significado, 0 = nada que ver. Devuelve 0 ante cualquier
// entrada inválida (un vector a medio armar no puede romper la búsqueda).
function similitud(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let punto = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    punto += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return punto / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- Persistencia (dato derivado: si se pierde, se recalcula) ----------
// Los vectores van en base64 de Float32Array: 768 floats en JSON completo pesan ~14 KB
// por sección; así pesan ~4 KB y la pérdida de precisión no cambia una similitud.
function empaquetar(vector) {
  return Buffer.from(Float32Array.from(vector).buffer).toString('base64');
}

function desempaquetar(texto) {
  const buffer = Buffer.from(String(texto || ''), 'base64');
  const flotantes = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
  return Array.from(flotantes);
}

// Cada modelo tiene su propia entrada: vectores de modelos distintos no son comparables,
// así que nunca se mezclan. Al arrancar se adopta la entrada más reciente (o la del
// GEMINI_EMBED_MODEL forzado), que es la que había funcionado la última vez.
function leerArchivo() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))?.modelos ?? {};
  } catch (error) {
    console.warn(`[TriggerBOT] IA: no pude leer data/embeddings.json (se recalcula): ${error.message}`);
    return {};
  }
}

function cargar() {
  if (cacheCargada) return;
  cacheCargada = true;
  try {
    const entradas = leerArchivo();
    const forzado = String(process.env.GEMINI_EMBED_MODEL || '').trim();
    const nombres = Object.keys(entradas);
    if (!nombres.length) return;
    const elegido = forzado
      ? (entradas[forzado] ? forzado : null)
      : nombres.sort((a, b) => (entradas[b]?.actualizado ?? 0) - (entradas[a]?.actualizado ?? 0))[0];
    if (!elegido) return;

    modelo = elegido;
    for (const [clave, empaquetado] of Object.entries(entradas[elegido]?.vectores ?? {})) {
      try {
        vectores.set(clave, desempaquetar(empaquetado));
      } catch {
        /* vector ilegible: se recalcula */
      }
    }
  } catch (error) {
    console.warn(`[TriggerBOT] IA: la caché de embeddings quedó ilegible (se recalcula): ${error.message}`);
    vectores = new Map();
  }
}

function guardar() {
  try {
    if (!modelo) return;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const entradas = leerArchivo();
    entradas[modelo] = {
      actualizado: Date.now(),
      dimensiones: vectores.values().next().value?.length ?? 0,
      vectores: Object.fromEntries([...vectores].map(([clave, vector]) => [clave, empaquetar(vector)])),
    };
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ actualizado: Date.now(), modelos: entradas }));
    fs.renameSync(tmp, FILE); // atómico: si algo falla, no se corrompe la caché
  } catch (error) {
    // La caché es una optimización: si el disco falla, se sigue funcionando (recalcula).
    console.warn(`[TriggerBOT] IA: no pude guardar data/embeddings.json: ${error.message}`);
  }
}

// ---------- Estado ----------
function habilitado() {
  return process.env.KB_SEMANTICO !== 'off' && process.env.KB_SEMANTICO !== 'false';
}

function clave() {
  return process.env.GEMINI_API_KEY || null;
}

function disponible() {
  return Boolean(habilitado() && clave() && Date.now() >= castigadoHasta);
}

function candidatos() {
  const forzado = String(process.env.GEMINI_EMBED_MODEL || '').trim();
  return forzado ? [forzado] : MODELOS_POR_DEFECTO;
}

function castigar(ms, motivo) {
  castigadoHasta = Date.now() + ms;
  motivoCastigo = motivo;
}

function motivoDeEstado() {
  if (!habilitado()) return 'deshabilitada con KB_SEMANTICO';
  if (!clave()) return 'sin clave de Gemini (GEMINI_API_KEY)';
  if (Date.now() < castigadoHasta) return `en pausa: ${motivoCastigo}`;
  return null;
}

// Foto del estado para /diag y las estadísticas del buscador. No llama a nadie.
function estado() {
  return {
    habilitada: habilitado(),
    disponible: disponible(),
    motivo: motivoDeEstado(),
    modelo,
    documentos: vectores.size,
    consultas: consultas.size,
    recuperaEnMs: Math.max(castigadoHasta - Date.now(), 0),
  };
}

// ---------- Llamada al proveedor ----------
function cuerpoDe(textos, { tipo = 'documento' } = {}) {
  const nombre = modelo ?? candidatos()[Math.min(candidato, candidatos().length - 1)];
  return {
    model: `models/${nombre}`,
    requests: textos.map((texto) => ({
      model: `models/${nombre}`,
      content: { parts: [{ text: recortar(texto) }] },
      // taskType separa "esto es una pregunta" de "esto es un documento": es lo que hace
      // que la comparación sea de recuperación y no de tema general. Si el modelo no lo
      // acepta, se reintenta sin él (una sola vez, y queda recordado).
      ...(sinTaskType ? {} : { taskType: tipo === 'consulta' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' }),
    })),
  };
}

function urlDe(nombre) {
  return `${API}/models/${nombre}:batchEmbedContents?key=${clave()}`;
}

// Un lote contra el modelo activo. Devuelve { vectores } o { error, estado }.
async function pedirLote(textos, { tipo }) {
  const nombre = modelo ?? candidatos()[Math.min(candidato, candidatos().length - 1)];
  let respuesta;
  try {
    respuesta = await fetchImpl(urlDe(nombre), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpoDe(textos, { tipo })),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { error: error.message, castigo: CASTIGO_ERROR_MS, motivo: 'sin respuesta del proveedor' };
  }

  if (!respuesta?.ok) {
    const codigo = Number(respuesta?.status) || 0;
    // Modelo inexistente: se pasa al siguiente nombre de la lista (una vez por nombre).
    if (codigo === 404 && !process.env.GEMINI_EMBED_MODEL) {
      candidato += 1;
      return { error: `modelo ${nombre} no existe`, reintentar: candidato < candidatos().length };
    }
    // taskType no soportado: se reintenta sin él y no se vuelve a mandar.
    if (codigo === 400 && !sinTaskType) {
      sinTaskType = true;
      return { error: 'el modelo no acepta taskType', reintentar: true };
    }
    if (codigo === 401 || codigo === 403) return { error: 'la clave no sirve para embeddings', castigo: CASTIGO_CLAVE_MS, motivo: 'clave inválida' };
    if (codigo === 429) return { error: 'cuota de embeddings agotada', castigo: CASTIGO_ERROR_MS, motivo: 'cuota agotada' };
    return { error: `HTTP ${codigo}`, castigo: CASTIGO_TAREA_MS, motivo: `error ${codigo}` };
  }

  try {
    const datos = await respuesta.json();
    const lista = datos?.embeddings;
    if (!Array.isArray(lista) || lista.length !== textos.length) return { error: 'respuesta sin embeddings', castigo: CASTIGO_TAREA_MS, motivo: 'respuesta inesperada' };
    return { vectores: lista.map((e) => (Array.isArray(e?.values) ? e.values : null)) };
  } catch (error) {
    return { error: error.message, castigo: CASTIGO_TAREA_MS, motivo: 'respuesta ilegible' };
  }
}

// ---------- API principal ----------
// Devuelve un vector por texto (en el mismo orden) o null si no se pudo. Nunca lanza.
// `tipo`: 'documento' (secciones de la base) o 'consulta' (la pregunta del usuario).
async function vectorizar(textos, { tipo = 'documento' } = {}) {
  const lista = (Array.isArray(textos) ? textos : [textos]).map((t) => String(t ?? ''));
  if (!lista.length) return [];

  const memo = tipo === 'consulta' ? consultas : vectores;
  const ahora = Date.now();

  if (tipo === 'documento') cargar();

  const faltantes = [];
  const salida = lista.map((texto) => {
    const claveTexto = hashDe(texto);
    const guardado = memo.get(claveTexto);
    if (tipo === 'consulta') {
      if (guardado && ahora - guardado.cuando < TTL_CONSULTA_MS) return guardado.vector;
    } else if (guardado) {
      return guardado;
    }
    faltantes.push({ clave: claveTexto, texto });
    return null;
  });
  if (!faltantes.length) return salida;

  if (!disponible()) return null;

  for (let i = 0; i < faltantes.length; i += LOTE) {
    const lote = faltantes.slice(i, i + LOTE);
    let resultado = await pedirLote(
      lote.map((f) => f.texto),
      { tipo }
    );
    // Un reintento cuando corresponde (siguiente modelo o sin taskType).
    if (resultado.reintentar) {
      resultado = await pedirLote(
        lote.map((f) => f.texto),
        { tipo }
      );
    }
    if (resultado.vectores) {
      modelo = candidatos()[Math.min(candidato, candidatos().length - 1)];
      castigadoHasta = 0;
      motivoCastigo = null;
      resultado.vectores.forEach((vector, j) => {
        if (!Array.isArray(vector)) return;
        if (tipo === 'consulta') {
          consultas.set(lote[j].clave, { vector, cuando: ahora });
          if (consultas.size > MAX_CONSULTAS) {
            // Se van los más viejos (el Map conserva el orden de inserción).
            for (const [vieja] of consultas) {
              if (consultas.size <= MAX_CONSULTAS) break;
              consultas.delete(vieja);
            }
          }
        } else {
          vectores.set(lote[j].clave, vector);
        }
      });
      continue;
    }
    // Falló: se castiga al proveedor y se devuelve null (el buscador sigue con BM25).
    castigar(resultado.castigo ?? CASTIGO_ERROR_MS, resultado.motivo ?? 'error de embeddings');
    console.warn(`[TriggerBOT] IA: embeddings no disponibles (${resultado.error}); la base sigue con el buscador por palabras.`);
    return null;
  }

  if (tipo === 'documento') guardar();

  // La salida completa sale de la caché (lo recién calculado ya quedó adentro).
  return lista.map((texto) => {
    const guardado = memo.get(hashDe(texto));
    if (tipo === 'consulta') return guardado?.vector ?? null;
    return guardado ?? null;
  });
}

// ---------- Para los tests ----------
function usarFetch(fn) {
  fetchImpl = fn;
}

function reiniciar() {
  fetchImpl = (...args) => fetch(...args);
  vectores = new Map();
  consultas.clear();
  modelo = null;
  candidato = 0;
  sinTaskType = false;
  castigadoHasta = 0;
  motivoCastigo = null;
  cacheCargada = false;
}

module.exports = {
  disponible,
  habilitado,
  vectorizar,
  similitud,
  estado,
  usarFetch,
  reiniciar,
  hashDe,
  // Para los tests: la ruta del archivo de caché y los límites.
  ARCHIVO: FILE,
  MODELOS_POR_DEFECTO,
  LOTE,
  MAX_CONSULTAS,
};
