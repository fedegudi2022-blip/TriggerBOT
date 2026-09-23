// Vigilancia: revisa los sistemas del bot y avisa al staff cuando algo se degrada.
//
// Por qué existe: el bot corre solo, sin nadie mirando la consola. Si un proveedor de
// IA se queda sin cuota, si alguien borra el canal hub de voz, si la base deja de
// aceptar escrituras o si el monitoreo de servidores se queda sin datos, la única
// forma de enterarse era que un usuario se quejara.
//
// Una sola función —`revisar()`— produce la lista de problemas y la usan dos cosas:
//   · `/diag`     → el staff la mira cuando quiere.
//   · `vigilar()` → avisa solo, cuando aparece algo nuevo.
// Al compartir el núcleo, el aviso automático y el comando nunca dicen cosas distintas.
//
// Los avisos tienen memoria: un problema se avisa UNA vez (no cada 5 minutos) y se
// avisa de nuevo cuando se resuelve o cuando empeora (de aviso a error).

const { getGuildConfig } = require('../store');
const { brandEmbed, COLORS, miles } = require('./replies');
const crearLogger = require('../logger');

const log = crearLogger('vigilancia');

// Umbrales de los chequeos.
const UMBRAL_IA_LENTA_MS = 4_000; // mediana de respuesta que ya se siente mal
const MUESTRAS_MINIMAS_IA = 4; // no se juzga la latencia con una sola respuesta
const UMBRAL_ESCRITURA_COLGADA_MS = 30_000; // el debounce es de 1,5 s: 30 s es "trabado"
const MARGEN_MONITOREO_MS = 60_000; // el tick es cada 90 s: +60 s ya es sospechoso

// `guildId` marca de qué servidor es el problema (null = global del bot). Se usa para
// saber a qué canal de avisos mandarlo, sin adivinar parseando el id.
function problema(id, nivel, titulo, detalle, accion, guildId = null) {
  return { id, nivel, titulo, detalle, accion, guildId };
}

// ---------- Comprobaciones ----------

// IA: claves, pausas, modelos y latencia real medida (utils/ia.js).
function revisarIA() {
  const problemas = [];
  let salud;
  try {
    salud = require('./ia').saludIA();
  } catch (error) {
    return [problema('ia-modulo', 'error', 'La capa de IA no cargó', error.message, 'Revisá los logs del arranque: `utils/ia.js` no se pudo inicializar.')];
  }

  const hayGroq = Boolean(process.env.GROQ_API_KEY);
  const hayGemini = Boolean(process.env.GEMINI_API_KEY);

  // Sin ninguna clave no es un problema: es una configuración válida (repertorio local).
  if (!hayGroq && !hayGemini) return problemas;

  for (const [nombre, clave, saludProv] of [
    ['Groq', hayGroq, salud.groq],
    ['Gemini', hayGemini, salud.gemini],
  ]) {
    if (!clave) continue;

    if (saludProv.enPausa) {
      const minutos = Math.max(1, Math.round(saludProv.vuelveEnMs / 60_000));
      problemas.push(
        problema(
          `ia-${nombre.toLowerCase()}-pausa`,
          'error',
          `${nombre} en pausa`,
          `El bot lo está salteando porque ${saludProv.motivoPausa}. Vuelve a intentarlo en ~${minutos} min.`,
          nombre === 'Groq'
            ? 'Revisá la clave y el plan en console.groq.com: los modelos gratuitos cambiaron de nombre más de una vez.'
            : 'Revisá la clave en aistudio.google.com/apikey y la cuota del proyecto.'
        )
      );
    } else if (saludProv.modelosCaidos.length && saludProv.p50 === null) {
      problemas.push(
        problema(
          `ia-${nombre.toLowerCase()}-sin-modelos`,
          'error',
          `${nombre} sin modelos utilizables`,
          `Se descartaron: ${saludProv.modelosCaidos.join(', ')}.`,
          'El bot ya está usando el respaldo, pero conviene revisar la configuración de la clave.'
        )
      );
    }

    if (saludProv.muestras >= MUESTRAS_MINIMAS_IA && saludProv.p50 !== null && saludProv.p50 > UMBRAL_IA_LENTA_MS) {
      problemas.push(
        problema(
          `ia-${nombre.toLowerCase()}-lenta`,
          'aviso',
          `${nombre} está respondiendo lento`,
          `Mediana de ${miles(saludProv.p50)} ms (p95 ${miles(saludProv.p95)} ms) sobre ${saludProv.muestras} respuestas.`,
          'Puede ser la red del hosting o el proveedor saturado. `/status` muestra el detalle.'
        )
      );
    }
  }

  return problemas;
}

// Base de conocimiento: sin secciones la IA contesta sin datos verificados.
// `directorio` existe para poder probar el caso vacío sin tocar la base real.
function revisarConocimiento(directorio) {
  try {
    const conocimiento = require('./conocimiento');
    const stats = conocimiento.estadisticas(directorio);
    if (!stats.secciones) {
      return [
        problema(
          'conocimiento-vacio',
          'error',
          'La base de conocimiento está vacía',
          'La IA no tiene de dónde sacar reglas, niveles ni comandos: va a responder que no sabe.',
          'Revisá que existan los archivos `docs/conocimiento/*.md` (se recargan solos cada minuto).'
        ),
      ];
    }
  } catch (error) {
    return [problema('conocimiento-error', 'error', 'La base de conocimiento falló', error.message, 'Revisá los logs: el buscador de conocimiento no se pudo leer.')];
  }
  return [];
}

// Archivos que no se pudieron cargar (los registra src/commandLoader.js y index.js).
function revisarCarga(client) {
  const fallos = client?.fallosCarga ?? [];
  if (!fallos.length) return [];
  return [
    problema(
      'carga-fallos',
      'error',
      `${fallos.length} archivo(s) no se pudieron cargar`,
      fallos.map((f) => `\`${f.archivo}\`: ${f.motivo}`).join('\n').slice(0, 900),
      'El bot arrancó sin eso. Revisá el commit con `npm run check` y corregí el módulo.'
    ),
  ];
}

// Base de datos: conexión, permiso de escritura y subidas.
async function revisarBaseDeDatos({ ping = false } = {}) {
  const problemas = [];
  let db;
  try {
    db = require('../db/mariadb');
  } catch {
    return problemas; // sin módulo de base, el bot funciona solo con data/ local
  }

  if (!db.configurada) return problemas;

  const estado = db.estado;
  if (ping) await db.ping().catch(() => {});

  if (!estado.conectado) {
    problemas.push(
      problema(
        'db-conexion',
        'error',
        'La base de datos no responde',
        `Último error: ${estado.ultimoError || 'desconocido'}.`,
        'El bot sigue funcionando con `data/` local, pero no está respaldando. Revisá `DB_HOST`/`DB_USER`/`DB_PASSWORD`.'
      )
    );
  } else if (estado.permisoEscritura === false) {
    problemas.push(
      problema(
        'db-sin-permiso',
        'error',
        'La base está conectada pero no acepta escrituras',
        'El respaldo en la nube no se está guardando (solo queda el JSON local).',
        'Revisá los GRANT del usuario de la base sobre las tablas `bot_*`.'
      )
    );
  } else if (estado.subidasFallidas >= 5) {
    problemas.push(
      problema(
        'db-errores',
        'aviso',
        'La base acumula errores de subida',
        `**${miles(estado.subidasFallidas)}** subidas fallaron (${miles(estado.subidasOk)} correctas).`,
        'Mirá el último error con `/diag` o los logs del bot.'
      )
    );
  }
  return problemas;
}

// Escrituras y subidas pendientes: si el debounce quedó hambriento, hay datos en
// memoria que todavía no están en disco ni en la base.
function revisarPendientes() {
  const problemas = [];

  try {
    const { pendientesDeGuardado } = require('../store');
    const pendiente = pendientesDeGuardado();
    if (pendiente.guilds && pendiente.masViejoMs > UMBRAL_ESCRITURA_COLGADA_MS) {
      problemas.push(
        problema(
          'escritura-colgada',
          'aviso',
          'Hay configuración sin guardar en disco',
          `**${pendiente.guilds}** servidor(es) con cambios esperando hace ${Math.round(pendiente.masViejoMs / 1000)} s.`,
          'Se guarda solo cuando pasa el debounce. Si sigue así, el proceso podría estar bloqueado.'
        )
      );
    }
  } catch {
    /* sin store no hay nada que revisar */
  }

  try {
    const sync = require('../db/sync');
    const pendientes = typeof sync.pendientesDeSubida === 'function' ? sync.pendientesDeSubida() : 0;
    if (pendientes > 10) {
      problemas.push(
        problema(
          'subidas-pendientes',
          'aviso',
          'Subidas a la base acumuladas',
          `**${pendientes}** almacén(es) esperando subir a MariaDB.`,
          'Suele indicar que la base está lenta o rechazando escrituras.'
        )
      );
    }
  } catch {
    /* sin sync no hay nada que revisar */
  }

  return problemas;
}

// Identificador estable derivado del texto del problema. No se usa la posición en la
// lista: si mañana aparece otro problema de voz antes, los ids no se corren y la
// memoria de avisos sigue reconociendo el mismo caso (no vuelve a avisar de algo ya
// avisado, ni lo da por resuelto por un cambio de orden).
function slug(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Voz: reusa el diagnóstico del propio sistema (una sola fuente de verdad).
function revisarVoz(guild) {
  if (!guild) return [];
  try {
    const voz = require('./voz');
    return voz.diagnosticoVoz(guild).map((p) =>
      problema(
        `voz-${guild.id}-${slug(p.texto)}`,
        p.nivel === 'error' ? 'error' : 'aviso',
        'Canales de voz temporales',
        p.texto,
        'Abrí `/voz estado` para el detalle completo.',
        guild.id
      )
    );
  } catch (error) {
    log.warn(`No pude diagnosticar voz en ${guild.id}: ${error.message}`);
    return [];
  }
}

// Monitoreo de servidores CS 1.6: que los datos no se queden viejos.
function revisarServidores(guild) {
  if (!guild) return [];
  const lista = getGuildConfig(guild.id).servidores?.lista ?? [];
  if (!lista.length) return [];

  let monitoreo;
  try {
    monitoreo = require('./monitoreo');
  } catch {
    return [];
  }

  const ahora = Date.now();
  let masNueva = 0;
  for (const server of lista) {
    const [host, puerto] = monitoreo.parsearDestino(server);
    const snapshot = monitoreo.cache.get(`${host}:${puerto}`);
    if (snapshot?.cuando) masNueva = Math.max(masNueva, snapshot.cuando);
  }

  const limite = monitoreo.INTERVALO_MS + MARGEN_MONITOREO_MS;
  // Aún no hay datos y el bot recién arranca: no es un problema todavía.
  if (!masNueva) {
    if (process.uptime() * 1000 > limite) {
      return [
        problema(
          `servidores-${guild.id}-sin-datos`,
          'aviso',
          'El monitoreo de servidores no tiene datos',
          `Hay **${lista.length}** server(s) cargados y ninguno respondió todavía.`,
          'Puede ser que los servidores estén caídos o que el hosting no pueda salir por UDP.',
          guild.id
        ),
      ];
    }
    return [];
  }

  if (ahora - masNueva > limite) {
    return [
      problema(
        `servidores-${guild.id}-viejo`,
        'aviso',
        'El monitoreo de servidores se quedó quieto',
        `El dato más nuevo tiene ${Math.round((ahora - masNueva) / 1000)} s (debería renovarse cada ${Math.round(monitoreo.INTERVALO_MS / 1000)} s).`,
        'El panel en vivo y las alertas de caída están desactualizados.',
        guild.id
      ),
    ];
  }
  return [];
}

// ---------- Revisión completa ----------

// Devuelve { problemas, chequeos } — problemas: lista para mostrar/avisar;
// chequeos: cuántos se corrieron, para que /diag pueda decir "revisé N sistemas".
async function revisar(client, { ping = false } = {}) {
  const problemas = [];
  const chequeos = [];

  const correr = (nombre, fn) => {
    chequeos.push(nombre);
    try {
      const salida = fn();
      if (Array.isArray(salida)) problemas.push(...salida);
    } catch (error) {
      log.error(`Falló el chequeo «${nombre}»`, error);
    }
  };

  correr('IA', () => revisarIA());
  correr('Conocimiento', () => revisarConocimiento());
  correr('Carga de archivos', () => revisarCarga(client));
  correr('Base de datos', () => revisarBaseDeDatos({ ping }));
  correr('Pendientes', () => revisarPendientes());

  for (const guild of client?.guilds?.cache?.values() ?? []) {
    correr(`Voz (${guild.name})`, () => revisarVoz(guild));
    correr(`Servidores (${guild.name})`, () => revisarServidores(guild));
  }

  // Los errores primero: es el orden en el que hay que leerlos.
  problemas.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'error' ? -1 : 1));
  return { problemas, chequeos };
}

// ---------- Avisos automáticos ----------

// Canal donde avisar: el mismo criterio que usa el monitoreo de servidores.
function canalDeAvisos(guild) {
  const config = getGuildConfig(guild.id);
  return guild.channels.cache.get(config.avisosChannel || config.logs || config.modlog) ?? null;
}

// Memoria de avisos: id → último problema avisado. Evita repetir y permite avisar
// cuando se resuelve. Se puede limpiar desde los tests.
const avisados = new Map();

function olvidarAvisos() {
  avisados.clear();
}

function embedProblemas(problemas) {
  const hayError = problemas.some((p) => p.nivel === 'error');
  return brandEmbed({
    color: hayError ? COLORS.error : COLORS.warn,
    title: hayError ? '🚨 Problema detectado' : '⚠️ Aviso de funcionamiento',
    description: problemas.map((p) => `**${p.titulo}**\n${p.detalle}\n> ${p.accion}`).join('\n\n').slice(0, 4000),
    footer: 'TriggerBOT • vigilancia automática · /diag para el detalle',
  });
}

function embedResueltos(problemas) {
  return brandEmbed({
    color: COLORS.success,
    title: '✅ Todo volvió a la normal',
    description: problemas.map((p) => `**${p.titulo}**`).join('\n'),
    footer: 'TriggerBOT • vigilancia automática',
  });
}

// Qué merece un mensaje: lo nuevo y lo que empeoró (de aviso a error). Lo que sigue
// igual no se repite, y lo que desapareció se reporta como resuelto. Es una función
// pura y exportada para poder probar la regla sin depender del estado del proceso.
function comparar(previos, actuales) {
  const nuevos = [];
  const resueltos = [];

  for (const [id, p] of actuales) {
    const previo = previos.get(id);
    if (!previo || (previo.nivel === 'aviso' && p.nivel === 'error')) nuevos.push(p);
  }
  for (const [id, previo] of previos) {
    if (!actuales.has(id)) resueltos.push(previo);
  }

  return { nuevos, resueltos };
}

// Revisa y avisa lo que cambió. Devuelve un resumen útil para tests y logs.
async function vigilar(client) {
  const { problemas } = await revisar(client);

  const actuales = new Map(problemas.map((p) => [p.id, p]));
  const { nuevos, resueltos } = comparar(avisados, actuales);

  avisados.clear();
  for (const [id, p] of actuales) avisados.set(id, p);

  if (!nuevos.length && !resueltos.length) return { nuevos: [], resueltos: [], avisados: 0 };

  // Globales → a un solo servidor (el primero con canal de avisos). Por servidor →
  // a ese servidor. Sin canal configurado no se avisa: /diag sigue mostrándolo.
  const guilds = [...(client?.guilds?.cache?.values() ?? [])];
  let enviados = 0;

  const enviar = async (guild, payload) => {
    const canal = canalDeAvisos(guild);
    if (!canal) return false;
    try {
      await canal.send(payload);
      enviados += 1;
      return true;
    } catch (error) {
      log.warn(`No pude avisar en ${guild.id}: ${error.message}`);
      return false;
    }
  };

  // A qué canal va cada cosa: los problemas de un servidor a ESE servidor; los
  // globales (IA, base, conocimiento, carga) a uno solo, para no repetir el mismo
  // aviso en cada servidor donde esté el bot.
  const destinoDe = (p) => guilds.find((g) => g.id === p.guildId) ?? guilds.find((g) => canalDeAvisos(g)) ?? null;

  const agrupar = (lista) => {
    const porGuild = new Map();
    for (const p of lista) {
      const destino = destinoDe(p);
      if (!destino) continue; // sin canal de avisos: queda para /diag
      const acumulado = porGuild.get(destino) ?? [];
      acumulado.push(p);
      porGuild.set(destino, acumulado);
    }
    return porGuild;
  };

  if (nuevos.length) {
    for (const [guild, lista] of agrupar(nuevos)) await enviar(guild, { embeds: [embedProblemas(lista)] });
  }
  if (resueltos.length) {
    for (const [guild, lista] of agrupar(resueltos)) await enviar(guild, { embeds: [embedResueltos(lista)] });
  }

  return { nuevos, resueltos, avisados: enviados };
}

module.exports = {
  revisar,
  vigilar,
  comparar,
  olvidarAvisos,
  canalDeAvisos,
  slug,
  // Chequeos sueltos: los usan los tests para forzar cada caso sin depender del estado
  // real del proceso (que en producción es el que manda, pero no se puede simular).
  revisarIA,
  revisarConocimiento,
  revisarCarga,
  revisarBaseDeDatos,
  revisarPendientes,
  revisarServidores,
  revisarVoz,
  UMBRAL_IA_LENTA_MS,
};
