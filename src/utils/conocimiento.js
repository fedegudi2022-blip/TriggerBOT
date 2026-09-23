// Base de conocimiento de la IA: lee los archivos .md de docs/conocimiento y devuelve
// los fragmentos más parecidos a la pregunta del usuario.
//
// Por qué existe: sin esto la IA responde con lo que "cree saber" del servidor
// (reglas, sanciones, comandos, IPs), y ahí es donde inventa. Con la base cargada
// responde solo con lo escrito por el staff, y cuando no encuentra nada lo dice y
// deriva al staff (ver utils/ia.js).
//
// Cómo busca: índice invertido por secciones (cada "## Título" es una sección) con
// puntaje BM25 — el algoritmo clásico de búsqueda, sin dependencias. Los términos se
// normalizan (sin tildes, sin mayúsculas) y se reducen a una raíz liviana para que
// "banear", "baneo" y "baneado" se encuentren entre sí.
//
// Recarga: los archivos se releen solos como máximo una vez por minuto (TTL), así el
// staff puede editar el .md y probar sin reiniciar el bot.
//
// Formato de los archivos: ver docs/conocimiento/README.md.

const fs = require('node:fs');
const path = require('node:path');

const DIR_POR_DEFECTO = path.join(__dirname, '..', '..', 'docs', 'conocimiento');
const RECARGA_MS = 60 * 1000;
const LIMITE_POR_DEFECTO = 3;
const MINIMO_POR_DEFECTO = 1.2; // se pondera por 0.25 como piso del corte (ver buscar)
const MAX_TROZO = 1200; // caracteres por sección dentro del prompt
const K1 = 1.5; // saturación de la frecuencia de término (BM25)
const B = 0.75; // normalización por largo del documento (BM25)

// Palabras vacías: no aportan a la búsqueda y ensucian el puntaje.
const STOPWORDS = new Set([
  'a', 'al', 'algo', 'algun', 'alguna', 'algunas', 'alguno', 'algunos', 'ante', 'antes', 'aqui',
  'asi', 'aun', 'con', 'conmigo', 'contra', 'cual', 'cuales', 'cuando', 'cuanto', 'cuanta',
  'de', 'del', 'demas', 'desde', 'donde', 'dos', 'el', 'ella', 'ellas', 'ello', 'ellos', 'en',
  'entonces', 'era', 'eran', 'eres', 'es', 'esa', 'ese', 'eso', 'esos', 'esta', 'estan', 'este',
  'esto', 'estos', 'estoy', 'fue', 'ha', 'hace', 'hacen', 'hacer', 'hacia', 'han', 'has', 'hasta',
  'hay', 'la', 'las', 'le', 'les', 'lo', 'los', 'mas', 'me', 'mi', 'mis', 'mucho', 'muchos',
  'muy', 'nada', 'ni', 'no', 'nos', 'nosotros', 'nuestro', 'o', 'os', 'otra', 'otras', 'otro',
  'otros', 'para', 'pero', 'poco', 'por', 'porque', 'que', 'quien', 'quienes', 'se', 'ser', 'si',
  'sin', 'sobre', 'solamente', 'solo', 'son', 'su', 'sus', 'tal', 'tambien', 'tan', 'tanto', 'te',
  'tener', 'tengo', 'ti', 'tiene', 'tienen', 'todo', 'todos', 'tu', 'tus', 'un', 'una', 'uno',
  'unos', 'usted', 'ustedes', 'va', 'voy', 'y', 'ya', 'yo',
  // Verbos y comodines de pregunta: aparecen en cualquier consulta y ensucian el
  // puntaje ("puedo poner publicidad" no debe ganar por el "pone" de otra sección).
  'aca', 'acá', 'ahi', 'ahí', 'alguien', 'anda', 'andan', 'cosa', 'cosas', 'dan', 'dar',
  'decime', 'decir', 'decis', 'dime', 'duda', 'dudas', 'hacen', 'hacés', 'hay', 'hoy',
  'luego', 'necesito', 'necesitan', 'nunca', 'pasa', 'pasan', 'podes', 'podés', 'pone',
  'ponen', 'poner', 'pregunta', 'preguntan', 'preguntar', 'puede', 'pueden', 'puedo',
  'queria', 'quería', 'quiero', 'sabe', 'sabes', 'saber', 'siempre', 'tema', 'temas',
  'tipo', 'usa', 'usan', 'usar', 'uso',
  // Verbos de "buscar/mirar": son genéricos y compiten con las palabras que importan.
  'aparece', 'aparecen', 'buscar', 'busco', 'listado', 'listar', 'mirar', 'veo', 'ver',
]);

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Corta en palabras y se queda con las significativas (>= 3 caracteres, sin vacías).
function tokenizar(texto) {
  return normalizar(texto)
    // Las barras primero: "/ban" y "ban" deben ser la misma palabra.
    .replace(/\//g, ' ')
    .split(/[^a-z0-9ñ]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// Claves de búsqueda de una palabra: la palabra entera y su raíz de 4 letras.
// Es un stemmer intencionalmente simple (sin librerías) que hace que "banear",
// "baneo" y "baneado" caigan todos en "bane", y "conectar"/"conecto" en "cone".
// En una base chica conviene encontrar de más que de menos: el umbral se encarga
// después de descartar lo que no viene al caso.
const LARGO_RAIZ = 4;
function claves(token) {
  if (token.length <= LARGO_RAIZ) return [token];
  return [token, token.slice(0, LARGO_RAIZ)];
}

// ---------- Lectura de los archivos ----------
// Divide cada archivo en secciones por "## Título". El "general" (texto antes del
// primer ##) se descarta: en estos archivos siempre es una introducción o el H1.
function leerSecciones(directorio) {
  let archivos;
  try {
    archivos = fs.readdirSync(directorio).filter((f) => f.endsWith('.md') && !/^(_|readme)/i.test(f));
  } catch (error) {
    console.warn(`[TriggerBOT] IA: no pude leer la base de conocimiento (${directorio}): ${error.message}`);
    return [];
  }

  const secciones = [];
  for (const archivo of archivos.sort()) {
    let contenido;
    try {
      contenido = fs.readFileSync(path.join(directorio, archivo), 'utf8');
    } catch (error) {
      console.warn(`[TriggerBOT] IA: no pude leer ${archivo}: ${error.message}`);
      continue;
    }

    let titulo = null;
    let cuerpo = [];
    const cerrar = () => {
      const texto = cuerpo.join('\n').trim();
      if (titulo && texto) secciones.push({ archivo, titulo, texto });
    };

    for (const linea of contenido.split(/\r?\n/)) {
      const marca = linea.match(/^##\s+(.+)$/);
      if (marca) {
        cerrar();
        titulo = marca[1].trim().replace(/[#*`]/g, '');
        cuerpo = [];
      } else if (titulo) {
        cuerpo.push(linea);
      }
    }
    cerrar();
  }
  return secciones;
}

// ---------- Índice invertido + BM25 ----------
function construirIndice(secciones) {
  const postings = new Map(); // término → Map(índice de sección → frecuencia)
  const largos = [];
  const palabras = []; // índice de sección → Set de palabras reales (sin claves de raíz)

  secciones.forEach((seccion, i) => {
    // El título pesa el doble: "Cómo entro a un servidor" debe ganarle a un párrafo
    // que menciona "servidor" al pasar.
    const lista = [...tokenizar(seccion.titulo), ...tokenizar(seccion.titulo), ...tokenizar(seccion.texto)];
    const conteo = new Map();
    for (const palabra of lista) {
      for (const clave of claves(palabra)) conteo.set(clave, (conteo.get(clave) || 0) + 1);
    }
    largos[i] = lista.length || 1;
    palabras[i] = new Set(lista);
    for (const [clave, tf] of conteo) {
      if (!postings.has(clave)) postings.set(clave, new Map());
      postings.get(clave).set(i, tf);
    }
  });

  const promedio = largos.length ? largos.reduce((a, b) => a + b, 0) / largos.length : 1;
  return { secciones, postings, largos, palabras, promedio };
}

function puntuar(consulta, indice) {
  const terminos = [...new Set(tokenizar(consulta))];
  const total = indice.secciones.length;
  if (!terminos.length || !total) return [];

  const puntajes = new Array(total).fill(0);
  for (const termino of terminos) {
    // Un término puede pegar por su forma exacta y por su raíz: se juntan los
    // documentos de ambas claves sin contar dos veces al mismo.
    const docs = new Map();
    for (const clave of claves(termino)) {
      const encontrados = indice.postings.get(clave);
      if (!encontrados) continue;
      for (const [i, tf] of encontrados) docs.set(i, Math.max(docs.get(i) || 0, tf));
    }
    if (!docs.size) continue;
    // IDF: un término que aparece en todas las secciones casi no aporta.
    const idf = Math.log(1 + (total - docs.size + 0.5) / (docs.size + 0.5));
    for (const [i, tf] of docs) {
      const norm = 1 - B + B * (indice.largos[i] / indice.promedio);
      // La palabra exacta vale más que la coincidencia por raíz: así "publicidad"
      // le gana al "pone" de "pone un modo lento" cuando preguntan por publicidad.
      const peso = indice.palabras[i]?.has(termino) ? 1 : 0.4;
      puntajes[i] += peso * idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }
  }

  // Bonus por frase exacta: "cómo entro al servidor" textual vale mucho más que las
  // mismas palabras sueltas repartidas.
  const frase = normalizar(consulta).trim();
  if (frase.length >= 8) {
    indice.secciones.forEach((s, i) => {
      if (puntajes[i] > 0 && normalizar(s.texto).includes(frase)) puntajes[i] += 3;
    });
  }

  return indice.secciones
    .map((s, i) => ({ ...s, puntaje: puntajes[i] }))
    .filter((s) => s.puntaje > 0)
    .sort((a, b) => b.puntaje - a.puntaje)
    .map((s) => ({ ...s }));
}

// ---------- Cache con TTL (recarga sola, sin reiniciar) ----------
const cache = new Map(); // directorio → { indice, archivos, cargado }

function obtenerIndice(directorio, forzar = false) {
  const guardado = cache.get(directorio);
  if (!forzar && guardado && Date.now() - guardado.cargado < RECARGA_MS) return guardado.indice;

  const secciones = leerSecciones(directorio);
  const indice = construirIndice(secciones);
  cache.set(directorio, { indice, cargado: Date.now() });
  if (secciones.length && !guardado) {
    console.log(`[TriggerBOT] IA: base de conocimiento con ${secciones.length} secciones (${directorio})`);
  }
  return indice;
}

// ---------- API ----------
// Devuelve las mejores secciones para la consulta (array vacío = no hay nada cargado
// sobre el tema). `directorio` y `forzar` existen para los tests.
function buscar(consulta, { limite = LIMITE_POR_DEFECTO, minimo = MINIMO_POR_DEFECTO, directorio = DIR_POR_DEFECTO, forzar = false } = {}) {
  const indice = obtenerIndice(directorio, forzar);
  if (!indice.secciones.length) return [];

  const puntuados = puntuar(consulta, indice);
  if (!puntuados.length) return [];

  // Umbral relativo al mejor puntaje (más un piso chico): así no se cuelan secciones
  // apenas relacionadas cuando hay una respuesta clarísima. No se usa un mínimo
  // absoluto grande porque el puntaje de BM25 depende del tamaño de la base (con
  // pocos archivos los IDF son chicos y un umbral fijo descartaría todo).
  const corte = Math.max(minimo * 0.25, puntuados[0].puntaje * 0.45);
  return puntuados
    .filter((s) => s.puntaje >= corte)
    .slice(0, limite)
    .map((s) => ({
      archivo: s.archivo,
      titulo: s.titulo,
      texto: s.texto.length > MAX_TROZO ? `${s.texto.slice(0, MAX_TROZO).trimEnd()}…` : s.texto,
      puntaje: Number(s.puntaje.toFixed(2)),
    }));
}

// Formatea los fragmentos para meterlos en el prompt de la IA.
function formatear(fragmentos) {
  return fragmentos.map((f) => `### ${f.titulo}\n${f.texto}`).join('\n\n');
}

// Texto listo para el prompt: '' cuando no hay nada útil cargado sobre el tema.
function contextoPara(consulta, opciones) {
  const fragmentos = buscar(consulta, opciones);
  return fragmentos.length ? formatear(fragmentos) : '';
}

// Vacía la cache (tests y recarga forzada desde el staff).
function recargar() {
  cache.clear();
}

// Cuántas secciones hay cargadas. Lee el índice si todavía no estaba en memoria (con
// el TTL de la cache, no golpea el disco en cada llamada): quien pregunte primero
// —/diag o la vigilancia— recibe el número real en vez de un 0 engañoso.
function estadisticas(directorio = DIR_POR_DEFECTO) {
  const indice = obtenerIndice(directorio);
  const guardado = cache.get(directorio);
  const secciones = indice.secciones;
  return {
    directorio,
    archivos: [...new Set(secciones.map((s) => s.archivo))].sort(),
    secciones: secciones.length,
    cargado: guardado?.cargado ?? null,
  };
}

module.exports = {
  buscar,
  contextoPara,
  formatear,
  recargar,
  estadisticas,
  tokenizar,
  normalizar,
  DIR_POR_DEFECTO,
  DIRECTORIO_POR_DEFECTO: DIR_POR_DEFECTO,
  MINIMO_POR_DEFECTO,
  LIMITE_POR_DEFECTO,
  MAX_TROZO,
};
