// Logger estructurado de TriggerBOT.
//
// Formato: [TriggerBOT] [NIVEL] [módulo] mensaje {ctx}
//   [TriggerBOT] [WARN] [supabase] Fallo al subir config:g1 {"guild":"123","intentos":2}
//
// ¿Por qué no una librería? El bot corre en Wispbyte y los logs se leen del panel:
// una línea plana con prefijos es lo más legible ahí, y cero dependencias = cero sorpresas.
//
// Reglas del proyecto:
//   - NUNCA loggear secreto alguno (DISCORD_TOKEN, SUPABASE_KEY): logger.sanitizar()
//     los enmascara si por accidente terminan en un mensaje de error.
//   - Los errores con contexto van con logger.error(mensaje, error, { guild, usuario, ... }).

const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 };

// Nivel mínimo: configurable con LOG_LEVEL (debug|info|warn|error). Por defecto info.
const nivelMinimo = NIVELES[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? NIVELES.info;

// Secretos que jamás deben aparecer en un log (por si un error los arrastra).
const SECRETOS = [];
for (const nombre of ['DISCORD_TOKEN', 'SUPABASE_KEY', 'SUPABASE_URL']) {
  if (process.env[nombre]) SECRETOS.push(process.env[nombre]);
}

function sanitizar(texto) {
  let salida = String(texto ?? '');
  for (const secreto of SECRETOS) {
    if (secreto && secreto.length >= 8) salida = salida.split(secreto).join('[REDACTADO]');
  }
  return salida;
}

// Contexto → sufijo plano: { guild: '123', usuario: '456' } → ' {guild:123, usuario:456}'
function formatearContexto(ctx) {
  if (!ctx) return '';
  const partes = Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}:${v}`);
  return partes.length ? ` {${partes.join(', ')}}` : '';
}

// Extrae el mensaje de un error (con causa) sin volcar el stack completo salvo en debug.
function mensajeDeError(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const causa = error.cause ? ` (causa: ${error.cause?.message ?? error.cause})` : '';
  const stack = nivelMinimo <= NIVELES.debug ? `\n${error.stack ?? ''}` : '';
  return `${error.message ?? String(error)}${causa}${stack}`;
}

function emitir(nivel, modulo, args) {
  if (NIVELES[nivel] < nivelMinimo) return;
  const [mensaje, error, ctx] = args;
  const linea = `${sanitizar(mensaje)}${formatearContexto(ctx)}`;
  const texto = error ? `${linea}: ${sanitizar(mensajeDeError(error))}` : linea;
  const completa = `[TriggerBOT] [${nivel.toUpperCase()}] [${modulo}] ${texto}`;
  if (nivel === 'error') console.error(completa);
  else if (nivel === 'warn') console.warn(completa);
  else console.log(completa);
}

// Uso: const log = require('./logger')('supabase');
//      log.info('Subido', null, { guild: id });
//      log.error('Fallo al subir', error, { guild: id });
module.exports = function crearLogger(modulo) {
  return {
    debug: (...args) => emitir('debug', modulo, args),
    info: (...args) => emitir('info', modulo, args),
    warn: (...args) => emitir('warn', modulo, args),
    error: (...args) => emitir('error', modulo, args),
    sanitizar,
  };
};

module.exports.sanitizar = sanitizar;
module.exports.nivelMinimo = nivelMinimo;
