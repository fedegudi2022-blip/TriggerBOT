// Búsqueda web para el chat con IA (utils/ia.js).
//
// Por qué existe: la IA tenía una sola fuente de verdad —el bloque INFORMACIÓN DEL
// SERVIDOR (contexto en vivo + docs/conocimiento)— y su instrucción era no afirmar
// nada que no estuviera ahí. Así, cualquier pregunta de cultura general ("¿cuántos
// años tiene Messi?") terminaba en "eso no lo tengo cargado, abrí un ticket". Este
// módulo le da la pata que faltaba: buscar afuera cuando la pregunta no es de la
// comunidad.
//
// Fuentes (todas sin clave de API, en paralelo y con timeout corto):
//   1. Wikipedia en español (API oficial): el resumen introductorio de la entidad más
//      parecida a la consulta. Es la que resuelve datos duros (fechas, edades,
//      biografías, países, obras).
//   2. DuckDuckGo Instant Answer (API oficial, sin clave): respuestas directas.
//   3. DuckDuckGo Lite (HTML público): resultados variados para lo que no está en
//      Wikipedia. Ojo: DDG suele contestar 202 a los clientes automatizados, así que
//      esta fuente aporta cuando quiere; si viene vacía o con otro HTML, se ignora
//      sin romper nada (la búsqueda es un extra, nunca un camino obligatorio).
//   4. Fuentes especializadas, solo cuando la pregunta es de ese tema: cotización del
//      dólar (Bluelytics) y clima (Open-Meteo + geocodificación). Son los dos datos
//      vivos que ningún modelo tiene al día y que más se piden en una comunidad
//      argentina.
//
// Investigar sin derrochar: si la primera ronda no trae nada, se reintenta con la
// Wikipedia en inglés y después con la consulta reducida a sus palabras con contenido
// ("¿cuántos años tiene Messi?" → "anios tiene messi"); cada etapa solo cuesta cuando
// la anterior vino vacía. Los pedidos simultáneos de la misma consulta se comparten.
//
// Cuándo se busca (`decidirBusqueda`): nunca en charla social; no para datos de la
// comunidad (ahí manda la base del server, que es la única verdad de las reglas); sí
// para preguntas de cultura general, y ANTES de responder cuando el usuario lo pide
// explícitamente ("buscá…") o cuando el dato es de los que cambian (precios,
// resultados, noticias, clima). Si la IA contesta "eso no lo tengo cargado" estando
// habilitada la búsqueda, utils/ia.js la reintenta con los resultados (rescate).
//
// Costos controlados: caché por consulta (10 min; 1 min si vino vacía), tope global
// de búsquedas por minuto, cooldown por usuario y timeout total. Una búsqueda lenta
// o caída no puede dejar al bot mudo ni hacerlo lento.

const { normalizar } = require('./conocimiento');

const TIMEOUT_FUENTE_MS = 3_500; // por fuente
const TIMEOUT_TOTAL_MS = 6_000; // techo de la búsqueda completa
const TTL_CACHE_MS = 10 * 60 * 1000;
const TTL_CACHE_VACIA_MS = 60 * 1000; // lo que falló se reintenta antes
const MAX_CACHE = 200;
const MAX_POR_MINUTO = 20; // tope global (protege contra flood y bloqueos de las fuentes)
const COOLDOWN_USUARIO_MS = 10 * 1000;
const MAX_RESULTADOS = 6;
const MAX_TEXTO_RESULTADO = 600;
const MAX_BLOQUE = 1_600; // caracteres que viajan al prompt
const MAX_POR_FUENTE = 4;

// El fetch es inyectable para que los tests corran sin red (usarFetch).
let fetchImpl = (url, opciones) => global.fetch(url, opciones);

function usarFetch(fn) {
  fetchImpl = fn;
}

// ---------- Estado de uso ----------
const cache = new Map(); // consulta normalizada → { resultados, cuando, ttl }
const enVuelo = new Map(); // consulta normalizada → promesa en curso (dedupe de pedidos iguales)
const usos = []; // timestamps de las últimas búsquedas (tope por minuto)
const ultimoPorUsuario = new Map();

function dormir(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function hayCupo() {
  const ahora = Date.now();
  while (usos.length && ahora - usos[0] > 60_000) usos.shift();
  return usos.length < MAX_POR_MINUTO;
}

function enCooldown(usuarioId) {
  if (!usuarioId) return false;
  const ultima = ultimoPorUsuario.get(usuarioId) ?? 0;
  return Date.now() - ultima < COOLDOWN_USUARIO_MS;
}

function registrarUso(usuarioId) {
  usos.push(Date.now());
  if (usuarioId) {
    ultimoPorUsuario.set(usuarioId, Date.now());
    if (ultimoPorUsuario.size > 500) {
      const ahora = Date.now();
      for (const [id, ts] of ultimoPorUsuario) {
        if (ahora - ts > COOLDOWN_USUARIO_MS) ultimoPorUsuario.delete(id);
      }
    }
  }
}

// ---------- Intención: ¿esta charla necesita internet? ----------
// Palabras que atan la pregunta a la comunidad: ahí la verdad es docs/conocimiento
// (y el prompt del bot), no lo que diga internet.
const RE_COMUNIDAD =
  /\b(trigger|arena|comunidad|server|servidor(es)?|reglas?|normas?|sancion(es|ar|ado|a)?|warn(s|ing|ings)?|advertencia(s)?|ban(eo|ear|eado|ean|eo)?|bane(ar|o|a|ado|an)?|kick(eo|ear|eado)?|mute(ar|o|ado|a|an)?|silencio|silenciar|timeout|flood(eo)?|spam|ticket(s)?|canal(es)?|rol(es)?|staff|mods?|moderador(es)?|helper(s)?|admin(s)?|niveles?|xp|logro(s)?|racha|rango(s)?|ranking|ip(s)?|mapa|jugador(es)?|counter|cs\s?1\.6|mix|kz|torneo(s)?|clan(es)?|voz|afk|encuesta|meme(s)?|comandos?|discord|whatsapp|instagram|steam|help)\b|\/help/;

// Señales de pregunta. Se aplica sobre el texto normalizado (sin tildes).
const RE_PREGUNTA =
  /[?¿]|\b(quien|quienes|que|cual|cuales|como|cuando|donde|cuanto|cuanta|cuantos|cuantas|por que|para que|a que|de que)\b/;

// Pedido explícito de buscar afuera.
const RE_PEDIDO_BUSQUEDA =
  /\b(busca|buscame|buscar|busque|buscalo|googlea|googlealo|google|investiga|investigalo|averigua|averigualo|chatea|consultale|fijate en (internet|google|la web)|en (internet|google|la web)|por (internet|google)|\bwiki\b)/;

// Datos que cambian con el tiempo: la memoria del modelo llega desactualizada y estos
// se buscan ANTES de responder en vez de esperar a que diga que no sabe.
const RE_DATO_FRESCO =
  /\b(hoy|manana|ayer|ahora|actual|actuales|actualidad|ultimo|ultima|ultimos|ultimas|reciente(s)?|precio(s)?|cotizacion|dolar|clima|temperatura|pronostico|resultado(s)?|marcador|posiciones|tabla|noticias?|estrena|estreno|en vivo|proximo|proxima|esta (temporada|semana|tarde)|ano)\b/;

// ---------- Fuentes especializadas: se activan por tema ----------
// Cotización: sin alguna palabra de "valor" no se consulta ("cuántos dólares gana
// Messi" no es una pregunta de cotización).
const RE_DOLAR = /\b(dolar(es)?|blue|euro(s)?)\b/;
const RE_VALOR = /\b(a cuanto|cuanto (esta|salen|sale|vale|estan)|cotizacion|precio|valor|vale|se vende)\b/;
const RE_CLIMA = /\b(clima|pronostico|temperatura|llueve|llover|lluvia|va a llover|maxima|minima)\b/;

function esConsultaDeDolar(t) {
  return RE_DOLAR.test(t) && RE_VALOR.test(t);
}

// ¿Cuál es la pregunta? 'comunidad' (manda la base del server), 'general' (cultura
// general: va a internet) o 'charla' (charla social). Ante la duda gana 'comunidad':
// es preferible inyectar la base de más que responder una regla del server con lo que
// la IA "cree saber".
function clasificarConsulta(texto, { perfil = 'charla' } = {}) {
  const t = normalizar(String(texto || '')).trim();
  if (!t || perfil !== 'consulta') return 'charla';
  if (RE_COMUNIDAD.test(t)) return 'comunidad';
  if (esConsultaDeDolar(t) || RE_CLIMA.test(t)) return 'general';
  if (RE_PEDIDO_BUSQUEDA.test(t) || RE_PREGUNTA.test(t)) return 'general';
  return 'comunidad';
}

// ¿Hace falta buscar? `forzar` = buscar antes de responder (pedido explícito, dato
// perecedero o fuente especializada); `buscar` = dejar la búsqueda de reserva por si la
// IA contesta que no sabe.
function decidirBusqueda(texto, { perfil = 'charla' } = {}) {
  const t = normalizar(String(texto || '')).trim();
  if (!t || perfil !== 'consulta') return { buscar: false, forzar: false };
  // Cotización y clima solo se consiguen en vivo: van antes de responder siempre.
  if (esConsultaDeDolar(t) || RE_CLIMA.test(t)) return { buscar: true, forzar: true };
  if (RE_COMUNIDAD.test(t)) return { buscar: false, forzar: false };
  if (RE_PEDIDO_BUSQUEDA.test(t)) return { buscar: true, forzar: true };
  if (!RE_PREGUNTA.test(t)) return { buscar: false, forzar: false };
  return { buscar: true, forzar: RE_DATO_FRESCO.test(t) };
}

// ¿La respuesta de la IA es un "no tengo esa información"? Se usa para el rescate:
// buscar en la web y volver a preguntarle con los resultados. Solo mira respuestas
// cortas: un texto largo puede mencionar "no sé" al pasar y no es una negativa.
const RE_SIN_INFO = [
  /no lo tengo cargado/,
  /no (tengo|cuento con|dispongo de|manejo|encuentro) (esa|esta|la) (info|informacion|data|dato)/,
  /no (tengo|cuento con|dispongo de|manejo) informacion/,
  /no puedo (responder|contestar|confirmar|verificar) (eso|esa|esta|esto)/,
  /no se (eso|esa|la respuesta|de eso|cual es)/,
  /no estoy seguro de (eso|esa|la respuesta)/,
  /no me (consta|figura)/,
  /en mi base de datos no/,
  /lo siento,? no (tengo|puedo|se|cuento)/,
];

function pareceSinInfo(texto) {
  const t = normalizar(String(texto || '')).trim();
  if (!t || t.length > 400) return false;
  return RE_SIN_INFO.some((re) => re.test(t));
}

// ---------- Fuentes ----------
async function pedirJson(url) {
  const resp = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_FUENTE_MS) });
  if (!resp?.ok) throw new Error(`HTTP ${resp?.status ?? '?'}`);
  return resp.json();
}

async function pedirTexto(url) {
  const resp = await fetchImpl(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TriggerBOT)',
      'Accept-Language': 'es-AR,es;q=0.9',
    },
    signal: AbortSignal.timeout(TIMEOUT_FUENTE_MS),
  });
  if (!resp?.ok) throw new Error(`HTTP ${resp?.status ?? '?'}`);
  return resp.text();
}

// Primeras `n` frases: la intro de Wikipedia puede ser larguísima y al prompt le
// alcanza con el dato principal.
function primerasFrases(texto, n = 4) {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
  const partes = limpio.match(/[^.!?]+[.!?]+/g);
  if (!partes || partes.length <= n) return limpio;
  return partes.slice(0, n).join(' ').trim();
}

async function buscarWikipedia(consulta, idioma = 'es') {
  const url =
    `https://${idioma}.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search` +
    `&gsrsearch=${encodeURIComponent(consulta)}&gsrlimit=2&prop=extracts|info&exintro=1` +
    '&explaintext=1&inprop=url';
  const datos = await pedirJson(url);
  const paginas = Object.values(datos?.query?.pages || {});
  return paginas
    .filter((p) => p && typeof p.extract === 'string' && p.extract.trim())
    .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
    .map((p) => ({
      fuente: idioma === 'es' ? 'Wikipedia' : `Wikipedia (${idioma})`,
      titulo: p.title || '',
      texto: primerasFrases(p.extract),
      url: p.fullurl || '',
    }));
}

async function buscarInstantAnswer(consulta) {
  const url =
    `https://api.duckduckgo.com/?q=${encodeURIComponent(consulta)}` +
    '&format=json&no_html=1&skip_disambig=1&no_redirect=1';
  const d = await pedirJson(url);
  if (!d) return [];

  const salida = [];
  const directa = [d.Answer, d.AbstractText].find((t) => typeof t === 'string' && t.trim());
  if (directa) {
    salida.push({
      fuente: 'DuckDuckGo',
      titulo: d.Heading || '',
      texto: primerasFrases(directa),
      url: d.AbstractURL || '',
    });
  }
  for (const tema of (d.RelatedTopics || []).slice(0, MAX_POR_FUENTE)) {
    if (tema?.Text) {
      salida.push({ fuente: 'DuckDuckGo', titulo: tema.Name || '', texto: primerasFrases(tema.Text), url: tema.FirstURL || '' });
    }
  }
  return salida;
}

function descodificarHtml(texto) {
  return String(texto || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Los links de DDG Lite pasan por su redirección (/l/?uddg=<destino>): hay que
// desenvolverlos para poder citar la URL real.
function urlReal(href) {
  const limpio = String(href || '').trim();
  if (!limpio) return '';
  const envuelto = /[?&]uddg=([^&]+)/.exec(limpio);
  if (envuelto) {
    try {
      return decodeURIComponent(envuelto[1]);
    } catch {
      return '';
    }
  }
  if (limpio.startsWith('//')) return `https:${limpio}`;
  return limpio;
}

async function buscarDuckLite(consulta) {
  const html = await pedirTexto(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(consulta)}`);
  // El HTML de Lite es una tabla: cada resultado es un <a class="result-link"> y su
  // resumen viene en un <td class="result-snippet">. Los atributos pueden ir en
  // cualquier orden, así que se buscan con lookaheads.
  const enlaces = [
    ...String(html).matchAll(
      /<a\b(?=[^>]*class=['"]result-link['"])(?=[^>]*href="([^"]+)")[^>]*>([\s\S]*?)<\/a>/g
    ),
  ];
  const resumenes = [...String(html).matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)];

  const resultados = [];
  enlaces.slice(0, MAX_POR_FUENTE).forEach((m, i) => {
    const url = urlReal(m[1]);
    if (!/^https?:\/\//i.test(url)) return;
    const titulo = descodificarHtml(m[2]);
    const texto = descodificarHtml(resumenes[i]?.[1] || '');
    if (!titulo && !texto) return;
    resultados.push({ fuente: 'Web', titulo, texto, url });
  });
  return resultados;
}

// Cotización del dólar y el euro (API pública de Bluelytics, sin clave).
async function buscarDolar() {
  const d = await pedirJson('https://api.bluelytics.com.ar/v2/latest');
  const filas = [
    ['Dólar oficial', d?.oficial],
    ['Dólar blue', d?.blue],
    ['Euro oficial', d?.oficial_euro],
    ['Euro blue', d?.blue_euro],
  ].filter(([, v]) => Number.isFinite(v?.value_sell) || Number.isFinite(v?.value_avg));
  if (!filas.length) return [];

  const texto = filas
    .map(([nombre, v]) =>
      `${nombre}: compra $${Math.round(v.value_buy ?? v.value_avg)} / venta $${Math.round(v.value_sell ?? v.value_avg)}`
    )
    .join(' | ');
  const cuando = d?.last_update ? new Date(d.last_update).toLocaleString('es-AR') : '';

  return [
    {
      fuente: 'Bluelytics',
      titulo: 'Cotización del dólar en Argentina',
      texto: `${texto}${cuando ? ` (actualizado el ${cuando})` : ''}`,
      url: 'https://bluelytics.com.ar/',
    },
  ];
}

// Ruido que suele venir pegado al nombre de la ciudad: "clima en Rosario mañana".
const RE_RUIDO_CIUDAD = /^(hoy|manana|ayer|ahora|esta|este|estos|estas|semana|tarde|noche|finde|fin|proximos?|proximas?)$/i;

// Ciudad de la pregunta ("clima en Rosario", "va a llover en Buenos Aires mañana").
// Devuelve '' si no hay una ciudad clara: sin eso no se consulta nada, porque responder
// el clima de la ciudad equivocada es peor que no responder.
function ciudadDe(consulta) {
  const m = /\b(?:en|de|para)\s+([a-záéíóúñü\s.'-]{3,40})/i.exec(String(consulta || ''));
  if (!m) return '';
  return m[1]
    .replace(/[¿?¡!.,;:]|\b(que|y|me|dec[ií]s?)\b/gi, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 1 && !RE_RUIDO_CIUDAD.test(normalizar(p)))
    .slice(0, 4)
    .join(' ')
    .trim();
}

// Clima actual y de hoy/mañana (Open-Meteo: geocodificación + pronóstico, sin clave).
async function buscarClima(consulta) {
  const ciudad = ciudadDe(consulta);
  if (!ciudad) return [];

  const geo = await pedirJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(ciudad)}&count=1&language=es&format=json`
  );
  const lugar = geo?.results?.[0];
  if (!lugar) return [];

  const zona = lugar.timezone || 'America/Argentina/Buenos_Aires';
  const d = await pedirJson(
    'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${lugar.latitude}&longitude=${lugar.longitude}` +
      '&current=temperature_2m,apparent_temperature,precipitation' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      `&timezone=${encodeURIComponent(zona)}&forecast_days=2`
  );
  const ahora = d?.current;
  const hoy = d?.daily;
  // Sin todas las series no se arma el texto: mejor no responder que mandar un
  // "undefined°C" a Discord.
  const completo =
    ahora &&
    Number.isFinite(ahora.temperature_2m) &&
    Number.isFinite(ahora.apparent_temperature) &&
    [0, 1].every(
      (i) =>
        Number.isFinite(hoy?.temperature_2m_max?.[i]) &&
        Number.isFinite(hoy?.temperature_2m_min?.[i]) &&
        Number.isFinite(hoy?.precipitation_probability_max?.[i])
    );
  if (!completo) return [];

  const dia = (i) =>
    `${hoy.temperature_2m_max?.[i]}°C / ${hoy.temperature_2m_min?.[i]}°C` +
    ` (lluvia ${hoy.precipitation_probability_max?.[i]}%)`;
  const texto =
    `Ahora: ${ahora.temperature_2m}°C (sensación ${ahora.apparent_temperature}°C). ` +
    `Hoy: ${dia(0)}. Mañana: ${dia(1)}.`;
  const ubicacion = [lugar.name, lugar.admin1, lugar.country].filter(Boolean).join(', ');

  return [{ fuente: 'Open-Meteo', titulo: `Clima en ${ubicacion}`, texto, url: 'https://open-meteo.com/' }];
}

// Se consultan en paralelo. Wikipedia en español primero porque la respuesta va en
// español; Wikipedia en inglés queda como último recurso (ver consultarFuentes), no en
// esta lista: no vale un viaje de red en cada búsqueda cuando la de acá ya responde.
const FUENTES = [buscarWikipedia, buscarInstantAnswer, buscarDuckLite];

// Las especializadas van primero y solo cuando la pregunta es de ese tema.
function fuentesDe(consulta) {
  const t = normalizar(consulta);
  const fuentes = [...FUENTES];
  if (esConsultaDeDolar(t)) fuentes.unshift(buscarDolar);
  if (RE_CLIMA.test(t)) fuentes.unshift(buscarClima);
  return fuentes;
}

// Consulta reducida a sus palabras con contenido: "¿cuántos años tiene Messi?" →
// "anios tiene messi". Los buscadores aciertan mucho más con los términos pelados que
// con la pregunta entera, así que se usa como último intento de la investigación.
const RE_VACIA =
  /^(cuanto|cuantos|cuanta|cuantas|quien|quienes|cual|cuales|como|cuando|donde|adonde|que|porque|tiene|tienen|hay|es|son|fue|era|esta|estan|tengo|tenes|podes|puede|puedo|sabes|decime|dime|para|por|con|sin|mas|muy|del|los|las|una|uno|unos|unas|sobre|segun|hace|hizo|al|el|la|de|en|y|o|a)$/;

function simplificar(consulta) {
  return normalizar(String(consulta || ''))
    .replace(/[¿?¡!.,;:"'()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !RE_VACIA.test(t))
    .join(' ')
    .trim();
}

function recortar(texto) {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
  return limpio.length > MAX_TEXTO_RESULTADO ? `${limpio.slice(0, MAX_TEXTO_RESULTADO).trimEnd()}…` : limpio;
}

// Sin duplicados (misma URL o mismo título) y con los textos recortados.
function depurar(resultados) {
  const vistos = new Set();
  const salida = [];
  for (const r of resultados) {
    if (!r?.texto) continue;
    const clave = String(r.url || r.titulo || r.texto).toLowerCase().slice(0, 90);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push({ ...r, texto: recortar(r.texto) });
    if (salida.length >= MAX_RESULTADOS) break;
  }
  return salida;
}

// Consulta todas las fuentes en paralelo: que una falle no cancela a las otras.
async function consultarFuentes(consulta) {
  const fuentes = fuentesDe(consulta);
  const respuestas = await Promise.allSettled(fuentes.map((fuente) => fuente(consulta)));
  const cayeron = respuestas.filter((r) => r.status === 'rejected');
  if (cayeron.length === fuentes.length) {
    const motivo = String(cayeron[0].reason?.message || cayeron[0].reason || 'error');
    console.warn(`[TriggerBOT] IA: la búsqueda web no pudo consultar ninguna fuente (${motivo}).`);
  }

  const resultados = [];
  for (const r of respuestas) {
    if (r.status === 'fulfilled') resultados.push(...r.value);
  }

  const encontrados = depurar(resultados);
  if (encontrados.length) return encontrados;

  // Segunda ronda: Wikipedia en inglés (hay temas que solo están bien cubiertos ahí).
  const enIngles = await intentar([() => buscarWikipedia(consulta, 'en')]);
  if (enIngles.length) return enIngles;

  // Tercera ronda: la misma investigación con la consulta reducida a sus palabras con
  // contenido. Es lo que hace que "¿cuántos años tiene Messi?" no se quede sin
  // respuesta por culpa del armado de la pregunta.
  const simple = simplificar(consulta);
  if (simple && simple !== normalizar(consulta).trim()) {
    return intentar([
      () => buscarWikipedia(simple),
      () => buscarWikipedia(simple, 'en'),
      () => buscarInstantAnswer(simple),
    ]);
  }
  return [];
}

// Ejecuta varios intentos en paralelo y devuelve el primero que traiga resultados.
async function intentar(tareas) {
  const respuestas = await Promise.allSettled(tareas.map((tarea) => tarea()));
  for (const r of respuestas) {
    if (r.status !== 'fulfilled') continue;
    const encontrados = depurar(r.value);
    if (encontrados.length) return encontrados;
  }
  return [];
}

// ---------- API ----------
// Devuelve los resultados para la consulta (array vacío = no hay nada). Cachea,
// respeta el cooldown por usuario y el tope por minuto, y nunca tarda más que
// TIMEOUT_TOTAL_MS.
async function buscar(consulta, { usuarioId = null, forzar = false } = {}) {
  const clave = normalizar(String(consulta || '')).replace(/\s+/g, ' ').trim();
  if (clave.length < 4) return [];

  const guardado = cache.get(clave);
  if (guardado && Date.now() - guardado.cuando < guardado.ttl) return guardado.resultados;

  // Si alguien ya está buscando exactamente lo mismo, se engancha a esa búsqueda: dos
  // pedidos simultáneos de la misma consulta salen a internet una sola vez.
  if (enVuelo.has(clave)) return enVuelo.get(clave);

  if (!forzar && enCooldown(usuarioId)) return [];
  if (!hayCupo()) return [];

  registrarUso(usuarioId);
  const promesa = (async () => {
    const resultados = await Promise.race([
      consultarFuentes(consulta).catch(() => []),
      dormir(TIMEOUT_TOTAL_MS).then(() => []),
    ]);
    cache.set(clave, {
      resultados,
      cuando: Date.now(),
      ttl: resultados.length ? TTL_CACHE_MS : TTL_CACHE_VACIA_MS,
    });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return resultados;
  })();

  enVuelo.set(clave, promesa);
  try {
    return await promesa;
  } finally {
    enVuelo.delete(clave);
  }
}

// Los resultados como bloque de texto para el prompt ('' si no hay nada).
function formatear(resultados) {
  if (!resultados?.length) return '';
  const lineas = [];
  let total = 0;
  for (const r of resultados) {
    const linea =
      `- [${r.fuente}]${r.titulo ? ` ${r.titulo}:` : ''} ${r.texto}` + (r.url ? ` (${r.url})` : '');
    if (total + linea.length > MAX_BLOQUE) break;
    lineas.push(linea);
    total += linea.length;
  }
  return lineas.join('\n');
}

// Fuentes para mostrar en Discord: el dato sin fuente no es verificable. Se citan las
// que la respuesta pudo usar (máximo 3, sin repetir dominio/URL).
function formatearFuentes(resultados, { limite = 3 } = {}) {
  const vistos = new Set();
  const partes = [];
  for (const r of resultados ?? []) {
    const url = String(r?.url || '');
    const nombre = String(r?.fuente || 'Web');
    const clave = url || nombre;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    partes.push(url ? `[${nombre}](${url})` : nombre);
    if (partes.length >= limite) break;
  }
  return partes.length ? `🔎 Fuentes: ${partes.join(' · ')}` : '';
}

// ---------- Chequeo de conexión (lo usa /diag) ----------
// Una consulta mínima a Wikipedia: es la fuente que resuelve la mayoría de las
// preguntas y la que más rápido falla cuando el hosting no tiene salida a internet.
// El resultado se guarda para que /diag lo muestre sin repetir el pedido.
let ultimaVerificacion = null;

async function verificar({ forzar = false } = {}) {
  const MAX_EDAD_MS = 60_000;
  if (!forzar && ultimaVerificacion && Date.now() - ultimaVerificacion.cuando < MAX_EDAD_MS) {
    return ultimaVerificacion;
  }

  const inicio = Date.now();
  try {
    const resultados = await buscarWikipedia('enciclopedia');
    ultimaVerificacion = {
      ok: resultados.length > 0,
      ms: Date.now() - inicio,
      resultados: resultados.length,
      fuente: resultados[0]?.fuente || null,
      motivo: resultados.length ? null : 'las fuentes respondieron pero sin resultados',
      cuando: Date.now(),
    };
  } catch (error) {
    ultimaVerificacion = {
      ok: false,
      ms: Date.now() - inicio,
      resultados: 0,
      fuente: null,
      motivo: String(error?.message || error).slice(0, 120),
      cuando: Date.now(),
    };
  }
  return ultimaVerificacion;
}

// Última verificación ya hecha, sin disparar una nueva: /diag muestra acá la misma prueba
// que corrió la vigilancia, sin pagar otro pedido.
function estadoVerificacion() {
  return ultimaVerificacion;
}

// Respuesta armada sin IA (no hay claves o cayeron los proveedores): devuelve el
// primer resultado citando la fuente, o '' si la búsqueda no trajo nada.
async function respuestaSinIA(consulta, { usuarioId = null, forzar = false } = {}) {
  const resultados = await buscar(consulta, { usuarioId, forzar });
  const primero = resultados.find((r) => r.texto);
  if (!primero) return '';
  const encabezado = primero.titulo ? `**${primero.titulo}**\n` : '';
  const fuente = primero.url ? ` — [${primero.fuente}](${primero.url})` : ` — ${primero.fuente}`;
  return `🔎 Busqué esto${fuente}:\n${encabezado}${primero.texto}`;
}

// Vacía cache y contadores (tests).
function reiniciar() {
  cache.clear();
  enVuelo.clear();
  usos.length = 0;
  ultimoPorUsuario.clear();
  ultimaVerificacion = null;
}

module.exports = {
  buscar,
  formatear,
  formatearFuentes,
  verificar,
  estadoVerificacion,
  respuestaSinIA,
  decidirBusqueda,
  clasificarConsulta,
  pareceSinInfo,
  simplificar,
  ciudadDe,
  buscarWikipedia,
  buscarDolar,
  buscarClima,
  consultarFuentes,
  buscarInstantAnswer,
  buscarDuckLite,
  usarFetch,
  reiniciar,
  RE_COMUNIDAD,
  TIMEOUT_TOTAL_MS,
  MAX_BLOQUE,
  // Para /diagnóstico y tests.
  estadisticas: () => ({ enCache: cache.size, enVuelo: enVuelo.size, usosUltimoMinuto: usos.length, fuentes: FUENTES.length }),
};
