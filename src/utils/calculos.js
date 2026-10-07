// Cálculos exactos, sin IA y sin internet.
//
// Por qué existe: un porcentaje, una conversión de unidades o los días que faltan para una
// fecha tienen UNA respuesta exacta. La IA, en cambio, se equivoca con las cuentas (sobre
// todo los modelos chicos que usamos para ir rápido), tarda y consume presupuesto diario.
// Este módulo contesta esas preguntas al instante, sin gastar cuota — incluso con la IA
// caída o el presupuesto del día agotado, donde antes el bot no tenía nada que decir.
//
// Regla de oro: solo responde cuando está SEGURO. Si la frase no es exactamente una cuenta
// (hay prosa alrededor que no se puede ignorar), devuelve null y la pregunta sigue su
// camino normal hacia la IA. Un dato exacto equivocado sería peor que no contestar.

// ---------- Números escritos como los escribe la gente ----------
// Argentina usa el punto para los miles y la coma para los decimales (3.800 / 1,5), pero
// también llega lo contrario (2.5). Se resuelve con reglas explícitas y probadas.
function aNumero(token) {
  let t = String(token ?? '').trim();
  if (!/^\d[\d.,]*$/.test(t)) return null;

  const tienePunto = t.includes('.');
  const tieneComa = t.includes(',');

  if (tienePunto && tieneComa) {
    // El ÚLTIMO separador es el decimal (1.234,5 y 1,234.5 son el mismo número).
    const ultimo = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
    const enteros = t.slice(0, ultimo).replace(/[.,]/g, '');
    t = `${enteros}.${t.slice(ultimo + 1)}`;
  } else if (tieneComa) {
    // Solo coma: tres dígitos después = miles (1,500 → 1500); uno o dos = decimal (1,5).
    t = /,\d{3}$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (tienePunto) {
    // Solo punto: grupos de tres = miles (3.800 → 3800); si no, decimal (2.5).
    t = /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : t;
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Número para mostrar: hasta 6 decimales, sin ceros de relleno y con separador es-AR.
function formatear(n) {
  const redondeado = Math.round(Number(n) * 1e6) / 1e6;
  return redondeado.toLocaleString('es-AR', { maximumFractionDigits: 6 });
}

// Medidas (unidades): dos decimales alcanzan para cualquier conversión útil; con números
// chicos se dejan cuatro para no perder el dato (0,528344 galones → 0,5283).
function formatearMedida(n) {
  const absoluto = Math.abs(Number(n));
  const decimales = absoluto >= 1 ? 2 : 4;
  return (Math.round(Number(n) * 1e6) / 1e6).toLocaleString('es-AR', { maximumFractionDigits: decimales });
}

// ---------- Evaluador de expresiones ----------
// Parser descendente recursivo (precedencia: + − < × ÷ < ^ < funciones). No hay `eval`:
// cualquier token que no sea número, operador, paréntesis o función reconocida hace que
// la expresión entera se descarte.
function evaluar(expresion) {
  const limpio = String(expresion || '')
    .toLowerCase()
    .replace(/\bra[ií]z\b/g, 'sqrt')
    .replace(/\b(redondear|redondea)\b/g, 'round')
    .replace(/\babsoluto\b/g, 'abs');

  const tokens = limpio.match(/sqrt|abs|round|[+\-*/^()]|\d[\d.,]*/g);
  if (!tokens) return null;

  let i = 0;
  const comiendo = (esperado) => {
    if (tokens[i] !== esperado) return false;
    i += 1;
    return true;
  };

  function primario() {
    if (comiendo('(')) {
      const valor = suma();
      if (!comiendo(')')) throw new Error('paréntesis sin cerrar');
      return valor;
    }
    const token = tokens[i];
    if (token === 'sqrt' || token === 'abs' || token === 'round') {
      i += 1;
      const valor = primario();
      if (token === 'sqrt') return Math.sqrt(valor);
      return token === 'abs' ? Math.abs(valor) : Math.round(valor);
    }
    if (comiendo('-')) return -primario();
    if (comiendo('+')) return primario();
    const numero = aNumero(token);
    if (numero === null) throw new Error(`token inesperado: ${token}`);
    i += 1;
    return numero;
  }

  function potencia() {
    let valor = primario();
    while (comiendo('^')) valor = valor ** primario();
    return valor;
  }

  function producto() {
    let valor = potencia();
    for (;;) {
      if (comiendo('*')) valor *= potencia();
      else if (comiendo('/')) {
        const divisor = potencia();
        if (divisor === 0) throw new Error('división por cero');
        valor /= divisor;
      } else return valor;
    }
  }

  function suma() {
    let valor = producto();
    for (;;) {
      if (comiendo('+')) valor += producto();
      else if (comiendo('-')) valor -= producto();
      else return valor;
    }
  }

  try {
    const valor = suma();
    if (i !== tokens.length) return null; // sobró texto: no era solo una cuenta
    return Number.isFinite(valor) ? valor : null;
  } catch {
    return null;
  }
}

// ---------- Unidades ----------
// Cada unidad dice a qué familia pertenece y cuánto vale en la unidad base de esa familia.
const UNIDADES = {
  km: ['largo', 1000],
  kilometro: ['largo', 1000],
  metros: ['largo', 1],
  metro: ['largo', 1],
  m: ['largo', 1],
  cm: ['largo', 0.01],
  centimetro: ['largo', 0.01],
  mm: ['largo', 0.001],
  millas: ['largo', 1609.344],
  milla: ['largo', 1609.344],
  pies: ['largo', 0.3048],
  pie: ['largo', 0.3048],
  pulgadas: ['largo', 0.0254],
  pulgada: ['largo', 0.0254],
  kg: ['masa', 1],
  kilos: ['masa', 1],
  kilo: ['masa', 1],
  g: ['masa', 0.001],
  gramos: ['masa', 0.001],
  libras: ['masa', 0.45359237],
  libra: ['masa', 0.45359237],
  lb: ['masa', 0.45359237],
  toneladas: ['masa', 1000],
  litros: ['volumen', 1],
  litro: ['volumen', 1],
  l: ['volumen', 1],
  ml: ['volumen', 0.001],
  galones: ['volumen', 3.785411784],
  galon: ['volumen', 3.785411784],
  gal: ['volumen', 3.785411784],
  horas: ['tiempo', 3600],
  hora: ['tiempo', 3600],
  hs: ['tiempo', 3600],
  h: ['tiempo', 3600],
  minutos: ['tiempo', 60],
  minuto: ['tiempo', 60],
  min: ['tiempo', 60],
  segundos: ['tiempo', 1],
  segundo: ['tiempo', 1],
  seg: ['tiempo', 1],
  s: ['tiempo', 1],
};

// Nombres que la gente escribe y no son la clave de la tabla.
const ALIAS_UNIDADES = {
  kilometros: 'km',
  centimetros: 'cm',
  milimetros: 'mm',
  mts: 'm',
  kgs: 'kg',
  gramo: 'gramos',
  lbs: 'libras',
  galoness: 'galones',
  lts: 'l',
  segs: 'seg',
  mins: 'min',
};

const RE_UNIDADES = `${Object.keys(UNIDADES).join('|')}|celsius|cent[ií]grados|fahrenheit`;
const RE_CONVERSION = new RegExp(
  `(\\d[\\d.,]*)\\s*(?:grados?\\s*)?(°?\\s*(?:${RE_UNIDADES})\\b|°?\\s*[cf]\\b)\\s*(?:a|en|->|→)\\s*(?:grados?\\s*)?(°?\\s*(?:${RE_UNIDADES})\\b|°?\\s*[cf]\\b)`,
  'i'
);

function unidadDe(texto) {
  const limpio = String(texto || '')
    .toLowerCase()
    .replace(/[°\s]/g, '');
  if (!limpio) return null;
  if (limpio === 'c' || limpio === 'celsius' || limpio === 'centigrados') return 'celsius';
  if (limpio === 'f' || limpio === 'fahrenheit') return 'fahrenheit';
  const clave = ALIAS_UNIDADES[limpio] ?? limpio;
  return UNIDADES[clave] ? { clave, familia: UNIDADES[clave][0], factor: UNIDADES[clave][1] } : null;
}

function convertir(valor, desde, hasta) {
  // Temperatura: la única que no es una regla de tres.
  if (desde === 'celsius' || hasta === 'celsius' || desde === 'fahrenheit' || hasta === 'fahrenheit') {
    if (desde === hasta) return valor;
    if (desde === 'celsius' && hasta === 'fahrenheit') return (valor * 9) / 5 + 32;
    if (desde === 'fahrenheit' && hasta === 'celsius') return ((valor - 32) * 5) / 9;
    return null; // °C/°F contra km o kg no tiene sentido
  }
  if (desde.familia !== hasta.familia) return null;
  return (valor * desde.factor) / hasta.factor;
}

function nombreUnidad(u) {
  if (u === 'celsius') return '°C';
  if (u === 'fahrenheit') return '°F';
  return u.clave;
}

// ---------- Fechas ----------
const MESES = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

const NOMBRES_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Fecha de HOY en Argentina (no en UTC: a las 21 h acá ya es mañana en UTC y la cuenta
// saldría con un día de menos).
function hoyArgentina() {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .split('-')
    .map(Number);
  return { y, m, d };
}

const RE_FECHA =
  /(?:d[ií]as?)\s+(faltan|falta|quedan|queda|pasaron|hay)\s+(?:para|hasta|desde)\s+(?:el\s+)?(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+(?:de|del)\s+(\d{4}))?/;

function diasHasta(objetivo, hoy) {
  return Math.round((Date.UTC(objetivo.y, objetivo.m, objetivo.d) - Date.UTC(hoy.y, hoy.m - 1, hoy.d)) / 86_400_000);
}

function desdeFecha(t) {
  const m = RE_FECHA.exec(t);
  if (!m) return null;

  const [, verbo, diaCrudo, mesCrudo, anioCrudo] = m;
  const dia = Number(diaCrudo);
  const mes = MESES[mesCrudo];
  if (mes === undefined || dia < 1 || dia > 31) return null;

  const hoy = hoyArgentina();
  const futuro = !/(pasaron|hay)/.test(verbo);
  let anio = anioCrudo ? Number(anioCrudo) : hoy.y;
  if (!anioCrudo && futuro && diasHasta({ y: anio, m: mes, d: dia }, hoy) < 0) anio += 1;

  const objetivo = { y: anio, m: mes, d: dia };
  const dias = diasHasta(objetivo, hoy);
  const fecha = `<t:${Math.floor(Date.UTC(anio, mes, dia) / 1000)}:D>`;
  const cuando = `${dia} de ${NOMBRES_MESES[mes]} de ${anio}`;

  if (futuro) {
    if (dias === 0) return { tipo: 'fecha', texto: `Es **hoy**: ${cuando} (${fecha}).` };
    if (dias === 1) return { tipo: 'fecha', texto: `Falta **1 día** para el ${cuando} (${fecha}).` };
    return { tipo: 'fecha', texto: `Faltan **${formatear(dias)} días** para el ${cuando} (${fecha}).` };
  }
  if (dias === 0) return { tipo: 'fecha', texto: `Fue **hoy**: ${cuando} (${fecha}).` };
  if (dias === -1) return { tipo: 'fecha', texto: `Pasó **1 día** desde el ${cuando} (${fecha}).` };
  return { tipo: 'fecha', texto: `Pasaron **${formatear(Math.abs(dias))} días** desde el ${cuando} (${fecha}).` };
}

// ---------- Detectores ----------
function desdePorcentaje(t) {
  const m = /(?:el\s+|un\s+)?(\d[\d.,]*)\s*(?:%|por ciento)\s+de\s+(\d[\d.,]*)/.exec(t);
  if (!m) return null;
  const pct = aNumero(m[1]);
  const total = aNumero(m[2]);
  if (pct === null || total === null) return null;
  return { tipo: 'porcentaje', texto: `**${formatear(pct)}% de ${formatear(total)} = ${formatear((pct * total) / 100)}**` };
}

// "qué porcentaje es 45 de 300" y "cuánto por ciento representa 45 de 300".
function desdePorcentajeDe(t) {
  const m = /(?:qu[eé]|cu[aá]nto)\s+(?:por\s*ciento|porcentaje)\s+(?:es|son|representa[n]?|del?)?\s*(\d[\d.,]*)\s+de\s+(\d[\d.,]*)/.exec(t);
  if (!m) return null;
  const parte = aNumero(m[1]);
  const total = aNumero(m[2]);
  if (parte === null || total === null || total === 0) return null;
  return { tipo: 'porcentaje', texto: `**${formatear(parte)} de ${formatear(total)} es el ${formatear((parte / total) * 100)}%**` };
}

// "3800 + 18%" (aumento), "3800 - 18%" (descuento), "3800 * 18%" (solo el porcentaje).
function desdeAumento(t) {
  const m = /(\d[\d.,]*)\s*([+\-*/])\s*(\d[\d.,]*)\s*%/.exec(t);
  if (!m) return null;
  const base = aNumero(m[1]);
  const pct = aNumero(m[3]);
  if (base === null || pct === null) return null;

  const operadores = {
    '+': { signo: '+', calcular: (b, p) => b * (1 + p / 100) },
    '-': { signo: '−', calcular: (b, p) => b * (1 - p / 100) },
    '*': { signo: '×', calcular: (b, p) => (b * p) / 100 },
    '/': { signo: '÷', calcular: (b, p) => (p === 0 ? NaN : b / (p / 100)) },
  }[m[2]];

  const resultado = operadores.calcular(base, pct);
  if (!Number.isFinite(resultado)) return null;
  return { tipo: 'porcentaje', texto: `**${formatear(base)} ${operadores.signo} ${formatear(pct)}% = ${formatear(resultado)}**` };
}

function desdeConversion(t) {
  const m = RE_CONVERSION.exec(t);
  if (!m) return null;
  const valor = aNumero(m[1]);
  const desde = unidadDe(m[2]);
  const hasta = unidadDe(m[3]);
  if (valor === null || !desde || !hasta) return null;
  const convertido = convertir(valor, desde, hasta);
  if (convertido === null || !Number.isFinite(convertido)) return null;
  return {
    tipo: 'unidad',
    texto: `**${formatear(valor)} ${nombreUnidad(desde)} = ${formatearMedida(convertido)} ${nombreUnidad(hasta)}**`,
  };
}

// La cuenta "pelada": el mensaje tiene que ser SOLO una expresión (se acepta el pedido
// delante: "cuánto es …"). Cualquier prosa extra descarta el cálculo, que es lo que evita
// responder "= 7" a un mensaje que hablaba de otra cosa.
const RE_QUITA_PEDIDO =
  /^\s*(?:che,?\s+|hola,?\s+|trigger,?\s+)?(?:a\s+ver[,:]?\s+)?(?:cu[aá]nto\s+(?:es|da|son|vale|ser[ií]a|dar[ií]a|sale)?|calcul[aá](?:me|melo|lo)?|resolv[eé](?:me|melo|lo)?|resultado\s+de|cuenta\s+(?:cu[aá]nto\s+es)?)?\s*:?\s*/;

const RE_FUNCIONES = /\b(sqrt|ra[ií]z|abs|absoluto|round|redondear|redondea)\b/g;
const RE_SOLO_CUENTA = /^[\d\s+\-*/^().,]+$/;
const RE_SIGNO = /[+\-*/^]|\b(sqrt|abs|round)\b/;

function desdeExpresion(mensaje) {
  const sinPedido = mensaje
    .replace(/^[¿¡\s]+/, '')
    .replace(/\s*[?!¿¡]+\s*$/, '')
    .replace(RE_QUITA_PEDIDO, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sinPedido || sinPedido.length > 120) return null;

  const lista = sinPedido
    // "3 x 4" es una multiplicación escrita a mano (y en el celular la x es lo cómodo).
    .replace(/(\d)\s*[x×]\s*(\d)/g, '$1*$2')
    .replace(/\bpor\b/g, '*')
    // "raíz de 144" y "raiz cuadrada de 144" → "sqrt 144".
    .replace(/\bra[ií]z(?:\s+cuadrada)?\s+de\b/g, 'sqrt')
    .replace(/\bra[ií]z\s+cuadrada\b/g, 'sqrt')
    // Un signo "=" al final ("12 * 3 =") no cambia nada.
    .replace(/\s*=\s*$/, '')
    .trim();

  // Sin nombres de función, el resto tiene que ser números, espacios y operadores.
  if (!RE_SOLO_CUENTA.test(lista.replace(RE_FUNCIONES, ' '))) return null;
  if (!/\d/.test(lista) || !RE_SIGNO.test(lista)) return null;

  const valor = evaluar(lista);
  if (valor === null) return null;
  const mostrada = lista
    .replace(/\bsqrt\b/g, '√')
    .replace(/\bround\b/g, 'redondear')
    .replace(/([\d)])\s*\*\s*/g, '$1 × ')
    .replace(/\s*\/\s*/g, ' ÷ ')
    .replace(/\s+/g, ' ')
    .trim();
  return { tipo: 'cuenta', texto: `**${mostrada} = ${formatear(valor)}**` };
}

// Punto de entrada: devuelve { tipo, texto } o null si la frase no es un cálculo exacto.
function resolver(mensaje) {
  const original = String(mensaje || '').trim();
  if (!original || original.length > 200) return null;

  const t = original
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return desdePorcentajeDe(t) ?? desdeAumento(t) ?? desdePorcentaje(t) ?? desdeConversion(t) ?? desdeFecha(t) ?? desdeExpresion(original);
}

module.exports = {
  resolver,
  evaluar,
  aNumero,
  formatear,
  convertir,
  unidadDe,
  hoyArgentina,
  RE_QUITA_PEDIDO,
};
