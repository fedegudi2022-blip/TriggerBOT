// Base de conocimiento de la IA: lee los archivos .md de docs/conocimiento y devuelve
// los fragmentos más parecidos a la pregunta del usuario.
//
// Por qué existe: sin esto la IA responde con lo que "cree saber" del servidor
// (reglas, sanciones, comandos, IPs), y ahí es donde inventa. Con la base cargada
// responde solo con lo escrito por el staff, y cuando no encuentra nada lo dice y
// deriva al staff (ver utils/ia.js).
//
// Cómo busca: dos señales sobre el mismo índice de secciones (cada "## Título" es una
// sección).
//   1. **BM25** por palabras —el algoritmo clásico, sin dependencias—: los términos se
//      normalizan (sin tildes, sin mayúsculas) y se reducen a una raíz liviana para que
//      "banear", "baneo" y "baneado" se encuentren entre sí.
//   2. **Búsqueda semántica** (utils/embeddings.js, opcional): vectores de la pregunta y
//      de las secciones comparados por significado, para los casos en que las palabras
//      no alcanzan ("cómo hago para que no me lleguen mensajes" → "Rol Silenciado").
//      Corre en `buscarHibrido()`: si BM25 ya reconoció el tema por una palabra del
//      título no se paga nada; si no, se combinan las dos señales. Sin clave de Gemini
//      (o con KB_SEMANTICO=off) todo sigue exactamente como antes.
//
// Recarga: los archivos se releen solos como máximo una vez por minuto (TTL), así el
// staff puede editar el .md y probar sin reiniciar el bot.
//
// Formato de los archivos: ver docs/conocimiento/README.md.

const fs = require('node:fs');
const path = require('node:path');
const embeddings = require('./embeddings');

const DIR_POR_DEFECTO = path.join(__dirname, '..', '..', 'docs', 'conocimiento');
const RECARGA_MS = 60 * 1000;
const LIMITE_POR_DEFECTO = 3;
const MINIMO_POR_DEFECTO = 1.2; // se pondera por 0.25 como piso del corte (ver buscar)
const MAX_TROZO = 1200; // caracteres por sección dentro del prompt
const K1 = 1.5; // saturación de la frecuencia de término (BM25)
const B = 0.75; // normalización por largo del documento (BM25)

// ---------- Búsqueda semántica: parámetros ----------
// Cuántas secciones puede aportar cada señal al ranking híbrido (el resultado final son
// `limite`, 3 por defecto): más candidatos = mejor reordenamiento sin costo extra.
const CANDIDATOS_BM25 = 12;
const CANDIDATOS_SEMANTICOS = 12;
// Similitud mínima para aceptar una sección que BM25 no encontró. Sin clave de Gemini no
// se usa: estos números se pueden afinar con KB_SEMANTICO_UMBRAL y KB_SEMANTICO_TITULO
// mirando la decisión real que muestra `/buscar` (staff).
const UMBRAL_SEMANTICO_POR_DEFECTO = 0.72;
// Umbral más alto para la señal "el tema está cargado" (la que decide si la base de la
// comunidad viaja al prompt cuando la pregunta parece de cultura general): un falso
// positivo ahí arrastraría reglas del server a una pregunta del mundo.
const UMBRAL_TITULO_POR_DEFECTO = 0.8;
// Si el cálculo de vectores falla, no se reintenta en cada pregunta: cada reintento
// costaba un viaje de red fallido.
const REINTENTO_SEMANTICO_MS = 5 * 60 * 1000;

function umbralDeEnv(nombre, porDefecto) {
  const valor = Number(process.env[nombre]);
  return Number.isFinite(valor) && valor > 0 && valor <= 1 ? valor : porDefecto;
}

function umbrales() {
  return {
    aceptar: umbralDeEnv('KB_SEMANTICO_UMBRAL', UMBRAL_SEMANTICO_POR_DEFECTO),
    titulo: umbralDeEnv('KB_SEMANTICO_TITULO', UMBRAL_TITULO_POR_DEFECTO),
  };
}

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

// Palabras del ARMADO de la pregunta (interrogativos y comodines que todavía quedan en
// el índice: 'como' sí aporta al ranking —"Cómo pido ayuda"—, pero no dice de qué habla
// la pregunta). Una coincidencia solo con estas palabras no alcanza para considerar que
// el tema está cargado (ver `enTitulo`): sin esto, "cómo se calcula el PBI" encontraba
// "Cómo entro a un servidor" y le metía al prompt una sección de la comunidad que no
// tenía nada que ver.
const PALABRAS_BLANDAS = new Set([
  'adonde', 'che', 'como', 'cuanta', 'cuantas', 'cuanto', 'cuantos',
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
  const tituloClaves = []; // índice de sección → Set de claves del título

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
    // Las claves del título aparte: una coincidencia en el título es la señal fuerte de
    // que el tema está realmente cargado (lo usa utils/ia.js para decidir si inyecta la
    // base de la comunidad en una pregunta que parece de cultura general).
    tituloClaves[i] = new Set(tokenizar(seccion.titulo).flatMap(claves));
    for (const [clave, tf] of conteo) {
      if (!postings.has(clave)) postings.set(clave, new Map());
      postings.get(clave).set(i, tf);
    }
  });

  const promedio = largos.length ? largos.reduce((a, b) => a + b, 0) / largos.length : 1;
  return { secciones, postings, largos, palabras, tituloClaves, promedio };
}

function puntuar(consulta, indice) {
  const terminos = [...new Set(tokenizar(consulta))];
  const total = indice.secciones.length;
  if (!terminos.length || !total) return [];

  const puntajes = new Array(total).fill(0);
  const coincidencias = Array.from({ length: total }, () => []);
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
      coincidencias[i].push(termino);
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
    .map((s, i) => ({
      ...s,
      pos: i, // posición en el índice: la necesita el ranking híbrido (buscarHibrido)
      puntaje: puntajes[i],
      coincidencias: coincidencias[i],
      // ¿La coincidencia tocó alguna palabra CON CONTENIDO del título de la sección? Es
      // la señal fuerte de que el tema está de verdad cargado: una sección que solo
      // coincide por "cómo" o "cuántos" no dice nada del tema de la pregunta.
      enTitulo: coincidencias[i].some(
        (t) => !PALABRAS_BLANDAS.has(t) && claves(t).some((k) => indice.tituloClaves[i]?.has(k))
      ),
    }))
    .filter((s) => s.puntaje > 0)
    .sort((a, b) => b.puntaje - a.puntaje)
    .map((s) => ({ ...s }));
}

// ---------- Cache con TTL (recarga sola, sin reiniciar) ----------
const cache = new Map(); // directorio → { indice, cargado }
let anuncioSemantico = null; // evita repetir el log en cada recarga del índice

function obtenerIndice(directorio, forzar = false) {
  const guardado = cache.get(directorio);
  if (!forzar && guardado && Date.now() - guardado.cargado < RECARGA_MS) return guardado.indice;

  const secciones = leerSecciones(directorio);
  const indice = construirIndice(secciones);
  cache.set(directorio, { indice, cargado: Date.now() });
  if (secciones.length && !guardado) {
    console.log(`[TriggerBOT] IA: base de conocimiento con ${secciones.length} secciones (${directorio})`);
  }
  // Los vectores se calculan en segundo plano: la primera pregunta que necesite la
  // semántica ya los encuentra listos. Sin clave de Gemini (o con KB_SEMANTICO=off) no
  // hace nada y la búsqueda sigue con BM25, exactamente como antes.
  asegurarVectores(indice).catch(() => {});
  return indice;
}

// ---------- API ----------
// Arma el fragmento que se devuelve (y que después entra al prompt). `origen` y
// `similitud` dejan auditables las dos señales: /buscar los muestra al staff.
function fragmentoDe(s, extra = {}) {
  return {
    archivo: s.archivo,
    titulo: s.titulo,
    texto: s.texto.length > MAX_TROZO ? `${s.texto.slice(0, MAX_TROZO).trimEnd()}…` : s.texto,
    puntaje: Number(Number(s.puntaje || 0).toFixed(2)),
    coincidencias: s.coincidencias ?? [],
    enTitulo: extra.enTitulo ?? Boolean(s.enTitulo),
    origen: extra.origen ?? 'bm25',
    similitud: extra.similitud ?? null,
  };
}

// Corte del ranking de BM25: relativo al mejor puntaje (más un piso chico), porque el
// puntaje depende del tamaño de la base (con pocos archivos los IDF son chicos y un
// umbral fijo descartaría todo).
function corteDe(puntuados, minimo) {
  return Math.max(minimo * 0.25, (puntuados[0]?.puntaje ?? 0) * 0.45);
}

function armar(puntuados, { limite, minimo }) {
  if (!puntuados.length) return [];
  const corte = corteDe(puntuados, minimo);
  return puntuados
    .filter((s) => s.puntaje >= corte)
    .slice(0, limite)
    .map((s) => fragmentoDe(s));
}

// Búsqueda clásica (BM25), síncrona: es el camino rápido de buscarHibrido y la que usan
// los tests. Array vacío = no hay nada cargado sobre el tema. `directorio` y `forzar`
// existen para los tests.
function buscar(consulta, { limite = LIMITE_POR_DEFECTO, minimo = MINIMO_POR_DEFECTO, directorio = DIR_POR_DEFECTO, forzar = false } = {}) {
  const indice = obtenerIndice(directorio, forzar);
  if (!indice.secciones.length) return [];
  return armar(puntuar(consulta, indice), { limite, minimo });
}

// Prepara (o reutiliza de la caché en disco) los vectores de las secciones. Idempotente:
// la llama la recarga del índice en segundo plano y buscarHibrido como red de seguridad.
// Devuelve true cuando los vectores quedaron listos.
//
// Si el cálculo ya está en curso, se ESPERA ese mismo trabajo en vez de devolver false:
// el que dispara la recarga lo hace de fondo (fire-and-forget) justo cuando llega una
// pregunta, y antes esa primera pregunta caía a la búsqueda por palabras sin necesidad.
async function asegurarVectores(indice) {
  if (indice.vectores) return true;
  if (!embeddings.disponible()) return false;
  if (indice.semanticoEnCurso) return indice.semanticoEnCurso;
  if (indice.semanticoFallidoEn && Date.now() - indice.semanticoFallidoEn < REINTENTO_SEMANTICO_MS) return false;

  indice.semanticoEnCurso = (async () => {
    try {
      const textos = indice.secciones.map((s) => `${s.titulo}\n${s.texto}`);
      const vectores = await embeddings.vectorizar(textos, { tipo: 'documento' });
      if (vectores && vectores.length === textos.length && vectores.every((v) => Array.isArray(v))) {
        indice.vectores = vectores;
        delete indice.semanticoFallidoEn;
        // Un solo aviso por cantidad de secciones: el índice se reconstruye cada minuto
        // (TTL) y los vectores salen de la caché, así que no hay que repetirlo.
        const firma = `${indice.secciones.length}:${vectores.length}`;
        if (anuncioSemantico !== firma) {
          anuncioSemantico = firma;
          console.log(`[TriggerBOT] IA: búsqueda semántica lista (${vectores.length} secciones · ${embeddings.estado().modelo})`);
        }
      } else {
        indice.semanticoFallidoEn = Date.now();
      }
    } catch (error) {
      // Nunca puede romper una búsqueda: si la semántica falla, queda BM25.
      indice.semanticoFallidoEn = Date.now();
      console.warn(`[TriggerBOT] IA: la búsqueda semántica falló (${error.message}); sigo con BM25.`);
    } finally {
      indice.semanticoEnCurso = null;
    }
    return Boolean(indice.vectores);
  })();

  return indice.semanticoEnCurso;
}

// Búsqueda híbrida (la que usa la charla): BM25 siempre, semántica cuando aporta. Es
// async porque el vector de la pregunta es una llamada de red — pero el camino común
// (BM25 con coincidencia en el título) no paga nada.
async function buscarHibrido(consulta, opciones = {}) {
  const { limite = LIMITE_POR_DEFECTO, minimo = MINIMO_POR_DEFECTO, directorio = DIR_POR_DEFECTO, forzar = false } = opciones;
  const indice = obtenerIndice(directorio, forzar);
  if (!indice.secciones.length) return [];

  const puntuados = puntuar(consulta, indice);
  const clasicos = armar(puntuados, { limite, minimo });
  // La base reconoció el tema con una palabra CON CONTENIDO del título: es la señal
  // fuerte y no hay nada que la semántica pueda mejorar. No se gasta una sola llamada.
  if (clasicos.length && clasicos[0].enTitulo) return clasicos;

  const listo = await asegurarVectores(indice);
  if (!listo) return clasicos;

  const [vectorConsulta] = (await embeddings.vectorizar([consulta], { tipo: 'consulta' })) || [];
  if (!vectorConsulta) return clasicos;

  const { aceptar, titulo } = umbrales();
  const cosenos = indice.secciones.map((_, i) => embeddings.similitud(vectorConsulta, indice.vectores[i]));

  // Candidatos: los que BM25 encontró (los mejores) más los más parecidos por coseno.
  const candidatos = new Map(); // pos → { s, bm25, cos }
  const corte = puntuados.length ? corteDe(puntuados, minimo) : Infinity;
  for (const s of puntuados.slice(0, CANDIDATOS_BM25)) {
    if (s.puntaje < corte) continue;
    candidatos.set(s.pos, { s, bm25: s.puntaje, cos: cosenos[s.pos] ?? 0 });
  }
  cosenos
    .map((cos, pos) => ({ pos, cos }))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, CANDIDATOS_SEMANTICOS)
    .forEach(({ pos, cos }) => {
      if (cos < aceptar || candidatos.has(pos)) return;
      candidatos.set(pos, { s: { ...indice.secciones[pos], puntaje: 0, coincidencias: [], enTitulo: false }, bm25: 0, cos });
    });
  if (!candidatos.size) return clasicos;

  // Cada señal se normaliza a [0,1] dentro del conjunto (comparar puntajes BM25 crudos
  // contra cosenos no tiene sentido: son escalas distintas) y se combinan. El significado
  // pesa un poco más: es la señal nueva, la que existe para los casos que las palabras no
  // alcanzan. Sin ninguna coincidencia de palabras, decide el coseno solo.
  const valoresBm25 = [...candidatos.values()].map((c) => c.bm25);
  const valoresCoseno = [...candidatos.values()].map((c) => c.cos);
  const normalizar = (valor, valores) => {
    const min = Math.min(...valores);
    const max = Math.max(...valores);
    if (max === min) return max > 0 ? 1 : 0;
    return (valor - min) / (max - min);
  };
  const hayBm25 = valoresBm25.some((v) => v > 0);

  const ordenados = [...candidatos.values()]
    .map((c) => ({
      ...c,
      hibrido: hayBm25
        ? 0.4 * normalizar(c.bm25, valoresBm25) + 0.6 * normalizar(c.cos, valoresCoseno)
        : normalizar(c.cos, valoresCoseno),
    }))
    .sort((a, b) => b.hibrido - a.hibrido);

  const elegidos = ordenados.filter((c) => c.bm25 > 0 || c.cos >= aceptar).slice(0, limite);
  if (!elegidos.length) return clasicos;

  return elegidos.map((c) =>
    fragmentoDe(c.s, {
      origen: c.bm25 > 0 && c.cos >= aceptar ? 'bm25+semantico' : c.bm25 > 0 ? 'bm25' : 'semantico',
      similitud: Number(c.cos.toFixed(3)),
      // Un coseno muy alto también cuenta como "el tema está cargado" (lo usa utils/ia.js
      // para decidir si inyecta la base de la comunidad): el umbral es más alto que el de
      // aceptación para no arrastrar preguntas del mundo a las reglas del server.
      enTitulo: Boolean(c.s.enTitulo) || c.cos >= titulo,
    })
  );
}

// Estado de la parte semántica (sin llamadas a la red): lo usan /diag, la vigilancia y
// /buscar para saber si la base está buscando solo por palabras.
function estadoSemantico(indice) {
  const proveedor = embeddings.estado();
  let estado = 'pendiente';
  if (!proveedor.habilitada) estado = 'deshabilitada';
  else if (!proveedor.disponible) estado = 'no-disponible';
  else if (indice?.vectores) estado = 'listo';
  else if (indice?.semanticoEnCurso) estado = 'calculando';
  else if (indice?.semanticoFallidoEn) estado = 'fallo';
  return {
    estado,
    modelo: proveedor.modelo,
    vectores: indice?.vectores?.length ?? 0,
    secciones: indice?.secciones?.length ?? 0,
    motivo: proveedor.motivo,
  };
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
    // Estado de la búsqueda semántica (no llama a la red): /diag y la vigilancia lo usan
    // para saber si la base está buscando solo por palabras.
    semantico: estadoSemantico(indice),
  };
}

module.exports = {
  buscar,
  buscarHibrido,
  contextoPara,
  formatear,
  recargar,
  estadisticas,
  estadoSemantico,
  umbrales,
  tokenizar,
  normalizar,
  PALABRAS_BLANDAS,
  DIR_POR_DEFECTO,
  DIRECTORIO_POR_DEFECTO: DIR_POR_DEFECTO,
  MINIMO_POR_DEFECTO,
  LIMITE_POR_DEFECTO,
  MAX_TROZO,
  CANDIDATOS_BM25,
  CANDIDATOS_SEMANTICOS,
  UMBRAL_SEMANTICO_POR_DEFECTO,
  UMBRAL_TITULO_POR_DEFECTO,
};
