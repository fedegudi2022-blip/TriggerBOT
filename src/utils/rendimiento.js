// Latencia real de las respuestas del bot, por perfil (charla / consulta / profundo).
//
// Por qué existe: /status ya mide a cada PROVEEDOR (cuánto tarda Groq, cuánto Gemini),
// pero no contestaba la otra pregunta del staff: "¿qué tipo de pregunta tarda más y por
// qué?". Una generación de Groq puede ser rapidísima y la respuesta tardar 7 segundos
// igual, porque hubo búsqueda antes de responder y un rescate con web encima. Sin separar
// el perfil y la causa, esa demora parecía culpa del proveedor.
//
// Cada respuesta de `conversar()` deja acá una muestra con:
//   · perfil       — cómo se clasificó la pregunta (charla / consulta / profundo);
//   · camino       — qué la resolvió: cálculo exacto, caché, IA o el repertorio local;
//   · ms           — la latencia real de punta a punta de ese turno;
//   · generaciones — cuántas veces se llamó al modelo (2+ = rescate con web);
//   · web          — si la búsqueda fue antes de responder, en paralelo o no hubo;
//   · sinIA        — por qué no hubo IA (presupuesto agotado o ningún proveedor).
//
// Es en memoria a propósito (igual que los contadores de /status): una escritura a disco
// por mensaje no se justifica para una métrica que se mira a mano. Las muestras describen
// el uso desde el arranque del bot; con 200 alcanza para una mediana estable y para ver
// las más lentas. Se muestra en /status (compacto) y en /latencias (detalle).

const MAX_MUESTRAS = 200; // ventana por proceso: una mediana estable, sin crecer sin control
const MAX_LENTAS = 5; // cuántas de las más lentas se guardan para mostrar
const MAX_PREGUNTA = 90; // la pregunta se guarda recortada: es para reconocerla, no para citarla

const muestras = [];

const ORDEN_PERFILES = ['charla', 'consulta', 'profundo'];
const ETIQUETAS_PERFIL = { charla: 'Charla', consulta: 'Consulta', profundo: 'Profundo' };

function registrar({
  perfil = 'charla',
  modo = null,
  camino = 'ia',
  ms = 0,
  generaciones = 0,
  web = 'no',
  sinIA = null,
  pregunta = '',
  cuando = Date.now(),
} = {}) {
  muestras.push({
    perfil,
    modo,
    camino,
    ms: Math.max(Math.round(ms), 0),
    generaciones: Math.max(Math.round(generaciones), 0),
    web,
    sinIA,
    pregunta: String(pregunta ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PREGUNTA),
    cuando,
  });
  if (muestras.length > MAX_MUESTRAS) muestras.shift();
}

// Percentil sobre una lista de tiempos (la mediana es la que el usuario "siente").
function percentil(tiempos, p) {
  if (!tiempos.length) return null;
  const orden = [...tiempos].sort((a, b) => a - b);
  const i = Math.min(Math.ceil((p / 100) * orden.length) - 1, orden.length - 1);
  return orden[Math.max(i, 0)];
}

// Milisegundos → texto corto: «820 ms», «2,1 s», «12 s».
function formatoDeMs(ms) {
  const n = Math.max(Math.round(Number(ms) || 0), 0);
  if (n < 1000) return `${n} ms`;
  const s = n / 1000;
  return s < 10 ? `${s.toFixed(1).replace('.', ',')} s` : `${Math.round(s)} s`;
}

// Por qué tardó esa respuesta, en palabras: es la columna que explica la demora
// (lo que el staff viene a averiguar cuando una pregunta tarda de más).
function causaDe(m) {
  if (m.camino === 'calculo') return 'cálculo exacto (sin IA)';
  if (m.camino === 'cache') return 'respondida de la caché';
  if (m.camino === 'local') {
    if (m.web === 'directa') return 'sin IA: dato de la web directo';
    if (m.sinIA === 'presupuesto') return 'sin IA: presupuesto del día agotado';
    return 'sin IA: ningún proveedor respondió';
  }
  const partes = [m.generaciones > 1 ? `${m.generaciones} generaciones (rescate con web)` : 'una generación'];
  if (m.web === 'forzada') partes.push('búsqueda antes de responder');
  else if (m.web === 'paralela') partes.push('búsqueda en paralelo usada');
  return partes.join(' + ');
}

const ordenDe = (perfil) => {
  const i = ORDEN_PERFILES.indexOf(perfil);
  return i === -1 ? ORDEN_PERFILES.length : i;
};

// Todo lo que necesitan /status y /latencias: por perfil, por causa y las más lentas.
function resumen() {
  const porPerfil = new Map();
  for (const m of muestras) {
    const acc = porPerfil.get(m.perfil) ?? { perfil: m.perfil, tiempos: [], caminos: { calculo: 0, cache: 0, ia: 0, local: 0 } };
    acc.tiempos.push(m.ms);
    acc.caminos[m.camino] = (acc.caminos[m.camino] ?? 0) + 1;
    porPerfil.set(m.perfil, acc);
  }

  const perfiles = [...porPerfil.values()]
    .map((a) => ({
      perfil: a.perfil,
      etiqueta: ETIQUETAS_PERFIL[a.perfil] ?? a.perfil,
      n: a.tiempos.length,
      p50: percentil(a.tiempos, 50),
      p95: percentil(a.tiempos, 95),
      max: Math.max(...a.tiempos),
      caminos: a.caminos,
    }))
    .sort((a, b) => ordenDe(a.perfil) - ordenDe(b.perfil));

  const causas = [];
  const agregarCausa = (id, etiqueta, filtro) => {
    const dentro = muestras.filter(filtro);
    if (!dentro.length) return;
    causas.push({ id, etiqueta, n: dentro.length, p50: percentil(dentro.map((m) => m.ms), 50) });
  };
  agregarCausa('forzada', 'Búsqueda antes de responder', (m) => m.web === 'forzada');
  agregarCausa('rescate', 'Rescate con web (2+ generaciones)', (m) => m.generaciones > 1);
  agregarCausa('ia', 'Una generación (camino normal)', (m) => m.camino === 'ia' && m.generaciones <= 1 && m.web !== 'forzada');
  agregarCausa('sinIA', 'Sin IA (presupuesto o proveedores)', (m) => m.camino === 'local');
  agregarCausa('instantaneas', 'Caché y cálculo (instantáneos)', (m) => m.camino === 'cache' || m.camino === 'calculo');

  // Las más lentas: la pregunta concreta que hay que mirar cuando alguien se queja.
  const lentas = [...muestras].sort((a, b) => b.ms - a.ms).slice(0, MAX_LENTAS);

  return {
    total: muestras.length,
    desde: muestras.length ? muestras[0].cuando : null,
    perfiles,
    causas,
    lentas,
  };
}

// Limpieza para los tests (y para volver a medir desde cero).
function reiniciar() {
  muestras.length = 0;
}

module.exports = { MAX_MUESTRAS, MAX_LENTAS, registrar, resumen, formatoDeMs, causaDe, reiniciar };
