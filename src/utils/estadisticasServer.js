// Canales de estadísticas del servidor: canales de VOZ de solo lectura cuyo NOMBRE lleva
// el número en vivo («👥 Miembros: 87.614», «🟢 En línea: 21.945», «🎭 Roles: 40»).
//
// Por qué canales de voz: es lo único cuyo nombre se puede cambiar por API y que se ve
// en la barra lateral sin abrir nada. Discord no permite renombrar categorías ni fijar
// texto al lado del nombre del servidor, así que este es el formato que usa todo el
// mundo (y el que muestra la ficha nativa del server, que es de donde sale esta idea).
//
// ---------- El límite que manda ----------
// Discord permite **2 renombres por canal cada 10 minutos**. Por eso el refresco corre
// cada 10 minutos y los renombres pasan por una cola por canal: si el cupo está usado,
// el cambio queda agendado y se aplica (con el valor MÁS NUEVO, recalculado) apenas se
// libera. Spamear setName no acelera nada: solo junta rechazos en el log.
//
// ---------- De dónde salen los números ----------
// Todos los cálculos son baratos menos los dos que dependen de la lista completa de
// miembros (humanos y en línea): esos los mantiene utils/censo.js con una foto cada 6 h
// y los eventos de presencia. Sin dato no se escribe un 0: el canal muestra «—» y
// `/stats estado` explica por qué.

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { miles } = require('./replies');
const censo = require('./censo');
const crearLogger = require('../logger');

const log = crearLogger('stats');

// Cada cuánto se revisan los números (alineado con los 2 renombres por canal cada 10 min).
const INTERVALO_MS = 10 * 60 * 1000;
// Límite real de Discord: 2 renombres por canal por cada 10 minutos.
const RENOMBRES_POR_VENTANA = 2;
const VENTANA_RENOMBRE_MS = 10 * 60 * 1000;
const MAX_NOMBRE = 100; // límite de Discord para el nombre de un canal
const NOMBRE_CATEGORIA = '📊 Estadísticas';
const MOTIVO = 'TriggerBOT: canal de estadísticas del servidor';
// Sin dato medido: un guion, nunca un número inventado ni un 0 que nadie midió.
const SIN_DATO = '—';

// ---------- Catálogo de métricas ----------
// Sumar una métrica es agregar una entrada: el comando, las opciones y los canales salen
// de acá. `valor` devuelve un número o null (null = no se pudo medir).
const METRICAS = [
  {
    id: 'miembros',
    etiqueta: 'Miembros',
    emoji: '👥',
    porDefecto: true,
    descripcion: 'Total de miembros (humanos + bots)',
    valor: (guild) => (Number.isFinite(guild.memberCount) ? guild.memberCount : null),
  },
  {
    id: 'humanos',
    etiqueta: 'Humanos',
    emoji: '🧑',
    porDefecto: false,
    descripcion: 'Miembros sin contar bots (necesita la lista completa)',
    valor: (guild) => {
      const { bots } = censo.datosDe(guild.id);
      if (!Number.isFinite(bots) || !Number.isFinite(guild.memberCount)) return null;
      return Math.max(guild.memberCount - bots, 0);
    },
  },
  {
    id: 'enLinea',
    etiqueta: 'En línea',
    emoji: '🟢',
    porDefecto: true,
    descripcion: 'Miembros conectados ahora (Presence Intent)',
    valor: (guild) => {
      const { enLinea } = censo.datosDe(guild.id);
      if (Number.isFinite(enLinea)) return enLinea;
      // Sin foto todavía (primer minuto tras el arranque): si la caché ya tiene a TODO el
      // servidor, contar de ahí es exacto y gratis. Si está incompleta, no se cuenta.
      if (!censo.tienePresencias(guild.client)) return null;
      const cache = guild.members?.cache;
      if (!cache || typeof cache.filter !== 'function') return null;
      if (!Number.isFinite(guild.memberCount) || cache.size < guild.memberCount) return null;
      return cache.filter((m) => m.presence && m.presence.status && m.presence.status !== 'offline').size;
    },
  },
  {
    id: 'roles',
    etiqueta: 'Roles',
    emoji: '🎭',
    porDefecto: true,
    descripcion: 'Cantidad de roles del servidor',
    valor: (guild) => guild.roles?.cache?.size ?? null,
  },
  {
    id: 'canales',
    etiqueta: 'Canales',
    emoji: '💬',
    porDefecto: false,
    descripcion: 'Cantidad de canales (texto, voz y categorías)',
    valor: (guild) => guild.channels?.cache?.size ?? null,
  },
  {
    id: 'boosts',
    etiqueta: 'Boosts',
    emoji: '🚀',
    porDefecto: false,
    descripcion: 'Impulsos activos del servidor',
    valor: (guild) => (Number.isFinite(guild.premiumSubscriptionCount) ? guild.premiumSubscriptionCount : null),
  },
];

// Alias que la gente escribe de verdad (sin tildes, como los normaliza el parser).
const SINONIMOS = {
  online: 'enLinea',
  enlinea: 'enLinea',
  conectados: 'enLinea',
  on: 'enLinea',
  gente: 'humanos',
  personas: 'humanos',
  total: 'miembros',
  miembros: 'miembros',
  canales: 'canales',
  boost: 'boosts',
  impulsos: 'boosts',
};

function metrica(id) {
  return METRICAS.find((m) => m.id === id) ?? null;
}

function idsValidos() {
  return METRICAS.map((m) => m.id);
}

function metricasPorDefecto() {
  return METRICAS.filter((m) => m.porDefecto).map((m) => m.id);
}

// «miembros, en linea, boosts» (o un array) → ids del catálogo, sin repetir. Lo que no
// reconoce se descarta: nunca se crea un canal para una métrica inexistente.
function normalizarMetricas(entrada) {
  const partes = (Array.isArray(entrada) ? entrada : String(entrada ?? '').split(/[,;|]+/))
    .map((parte) =>
      String(parte)
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\s_-]+/g, '')
    )
    .filter(Boolean);

  const ids = [];
  for (const parte of partes) {
    const id = metrica(parte) ? parte : SINONIMOS[parte];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// ---------- Nombres ----------
// «👥 Miembros: 87.614» · sin dato → «👥 Miembros: —». Se recorta a 100 caracteres:
// Discord rechaza el renombre completo si el nombre se pasa.
function nombreDeMetrica(id, valor) {
  const info = metrica(id);
  if (!info) return null;
  const numero = Number.isFinite(valor) ? miles(valor) : SIN_DATO;
  return `${info.emoji} ${info.etiqueta}: ${numero}`.slice(0, MAX_NOMBRE);
}

function valorDeMetrica(guild, id) {
  const info = metrica(id);
  if (!info) return null;
  try {
    const valor = info.valor(guild);
    return Number.isFinite(valor) ? valor : null;
  } catch {
    return null;
  }
}

// ---------- Config (por servidor, en store.js → viaja con el respaldo de MariaDB) ----------
function configDe(guildId) {
  return getGuildConfig(guildId).stats ?? {};
}

function activo(guildId) {
  const config = configDe(guildId);
  return config.activado === true && metricasActivas(guildId).length > 0;
}

// Métricas configuradas que existen de verdad en el catálogo (una id vieja o escrita a
// mano en la config no tiene que crear ni un canal ni un problema).
function metricasActivas(guildId) {
  return (configDe(guildId).metricas ?? []).filter((id) => Boolean(metrica(id)));
}

function canalIdDe(guildId, id) {
  return configDe(guildId).canales?.[id] ?? null;
}

function guardar(guildId, cambios) {
  setGuildConfig(guildId, (config) => {
    config.stats = { ...(config.stats ?? {}), ...cambios };
  });
}

// ---------- Cola de renombres (2 por canal cada 10 minutos) ----------
// canalId → { sellos: number[], timer, guild }
const colas = new Map();
// guildId → resultado de la última pasada (lo lee /stats estado y el diagnóstico).
const ultimasPasadas = new Map();

function limpiarCola(canalId) {
  const cola = colas.get(canalId);
  if (cola?.timer) clearTimeout(cola.timer);
  colas.delete(canalId);
}

function cuposLibres(cola) {
  const ahora = Date.now();
  cola.sellos = cola.sellos.filter((sello) => ahora - sello < VENTANA_RENOMBRE_MS);
  return RENOMBRES_POR_VENTANA - cola.sellos.length;
}

function programarReintento(canalId) {
  const cola = colas.get(canalId);
  if (!cola || cola.timer) return;
  const espera = Math.max(VENTANA_RENOMBRE_MS - (Date.now() - cola.sellos[0]) + 1_000, 1_000);
  cola.timer = setTimeout(() => {
    cola.timer = null;
    aplicarPendiente(canalId).catch((error) => log.warn(`Reintento de renombre falló (${canalId}): ${error.message}`));
  }, espera);
  cola.timer.unref?.();
}

// Aplica lo que quedó esperando cupo, recalculando el valor ACTUAL: entre el pedido y el
// momento del cupo pueden haber pasado 10 minutos, y el número viejo ya no sirve.
async function aplicarPendiente(canalId) {
  const cola = colas.get(canalId);
  if (!cola) return null;
  const guild = cola.guild;
  const canal = guild?.channels?.cache?.get(canalId);
  if (!canal) {
    limpiarCola(canalId);
    return null;
  }
  const id = metricasActivas(guild.id).find((candidata) => canalIdDe(guild.id, candidata) === canalId);
  if (!id) {
    limpiarCola(canalId);
    return null;
  }
  const objetivo = nombreDeMetrica(id, valorDeMetrica(guild, id));
  if (canal.name === objetivo) {
    cola.sellos = [];
    return null;
  }
  return encolarRenombre(guild, canal, objetivo);
}

// Intenta renombrar ahora. Devuelve el estado real, que es lo que se informa en el
// comando: 'renombrado' | 'espera' (cupo usado, quedó agendado) | 'rechazado' | 'perdido'.
async function encolarRenombre(guild, canal, objetivo) {
  if (!canal) return { estado: 'perdido' };
  if (canal.name === objetivo) return { estado: 'sin-cambio', canal, objetivo };

  const cola = colas.get(canal.id) ?? { sellos: [], timer: null, guild };
  cola.guild = guild;
  colas.set(canal.id, cola);

  if (cuposLibres(cola) <= 0) {
    programarReintento(canal.id);
    const reabreEnMs = Math.max(VENTANA_RENOMBRE_MS - (Date.now() - cola.sellos[0]) + 1_000, 1_000);
    return { estado: 'espera', canal, objetivo, reabreEnMs };
  }

  cola.sellos.push(Date.now());
  try {
    await canal.setName(objetivo, MOTIVO);
    return { estado: 'renombrado', canal, objetivo };
  } catch (error) {
    // Un rechazo (permisos, rate limit real) no se reintenta en bucle: se reporta y se
    // deja que la próxima pasada lo vuelva a intentar. Insistir solo llena el log.
    log.warn(`No pude renombrar «${objetivo}» (${canal.id}): ${error.message}`);
    return { estado: 'rechazado', canal, objetivo, motivo: error.message };
  }
}

// ---------- Alta, cambio de métricas y baja ----------

async function asegurarCategoria(guild, categoriaId) {
  if (categoriaId) {
    const elegida = guild.channels.cache.get(categoriaId);
    if (!elegida || elegida.type !== ChannelType.GuildCategory) {
      return { error: 'La categoría elegida no existe o no es una **categoría** (la cabecera que agrupa canales).' };
    }
    return { categoria: elegida };
  }

  const configurada = configDe(guild.id).categoriaId;
  const previa = configurada ? guild.channels.cache.get(configurada) : null;
  if (previa && previa.type === ChannelType.GuildCategory) return { categoria: previa };

  try {
    const creada = await guild.channels.create({ name: NOMBRE_CATEGORIA, type: ChannelType.GuildCategory, reason: MOTIVO });
    return { categoria: creada };
  } catch (error) {
    return { error: `No pude crear la categoría: ${error.message}` };
  }
}

// Canales de solo lectura: se ven (ese es el punto) pero nadie puede entrar a hablar solo.
const PERMISOS = (guild) => [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }];

async function crearCanalDeMetrica(guild, id, categoria) {
  const nombre = nombreDeMetrica(id, valorDeMetrica(guild, id));
  try {
    const canal = await guild.channels.create({
      name: nombre,
      type: ChannelType.GuildVoice,
      parent: categoria?.id,
      permissionOverwrites: PERMISOS(guild),
      reason: MOTIVO,
    });
    return { canal };
  } catch (error) {
    return { error: error.message };
  }
}

// Crea los canales que falten, borra los de las métricas que se sacaron y guarda la
// config. Es la única implementación de «qué canales tiene que haber»: la usan /stats
// activar y /stats metricas, así que no pueden quedar desincronizadas.
async function aplicarMetricas(guild, ids, { categoria }) {
  const canales = { ...(configDe(guild.id).canales ?? {}) };
  const creados = [];
  const borrados = [];
  const fallidos = [];

  for (const id of ids) {
    const existente = canales[id] ? guild.channels.cache.get(canales[id]) : null;
    if (existente) {
      // Ya está: solo se actualiza el nombre con el valor de ahora.
      await encolarRenombre(guild, existente, nombreDeMetrica(id, valorDeMetrica(guild, id)));
      continue;
    }
    const resultado = await crearCanalDeMetrica(guild, id, categoria);
    if (resultado.canal) {
      canales[id] = resultado.canal.id;
      creados.push({ id, canal: resultado.canal });
    } else {
      fallidos.push({ id, motivo: resultado.error });
    }
  }

  // Las métricas que ya no están: su canal se va (lo creó el bot, no es de nadie).
  for (const [id, canalId] of Object.entries(canales)) {
    if (ids.includes(id)) continue;
    const canal = guild.channels.cache.get(canalId);
    delete canales[id];
    limpiarCola(canalId);
    if (!canal) continue;
    try {
      await canal.delete(MOTIVO);
      borrados.push({ id, canal });
    } catch (error) {
      fallidos.push({ id, motivo: error.message });
    }
  }

  guardar(guild.id, {
    activado: true,
    categoriaId: categoria?.id ?? configDe(guild.id).categoriaId ?? null,
    metricas: ids,
    canales,
    actualizado: Date.now(),
  });

  // Sembrar el censo en segundo plano: sin la foto, «Humanos» y «En línea» mostrarían
  // «—» hasta la próxima pasada (que puede tardar horas).
  if (ids.some((id) => id === 'humanos' || id === 'enLinea')) {
    censo.sembrar(guild).catch((error) => log.warn(`Censo inicial de ${guild.id} falló: ${error.message}`));
  }

  return { creados, borrados, fallidos, canales };
}

async function activar(guild, { categoriaId = null, metricas = null } = {}) {
  const elegidas = normalizarMetricas(metricas);
  const ids = elegidas.length ? elegidas : metricasPorDefecto();

  const { categoria, error } = await asegurarCategoria(guild, categoriaId);
  if (error) return { ok: false, error };

  const resultado = await aplicarMetricas(guild, ids, { categoria });
  return { ok: true, categoria, ids, ...resultado };
}

// Cambiar métricas sin tocar la categoría (y sin crear una si no hay).
async function cambiarMetricas(guild, metricas) {
  const ids = normalizarMetricas(metricas);
  if (!ids.length) return { ok: false, error: `No reconocí ninguna métrica válida. Las que hay son: ${idsValidos().join(', ')}.` };

  const configurada = configDe(guild.id).categoriaId;
  const categoria = configurada ? (guild.channels.cache.get(configurada) ?? null) : null;
  const resultado = await aplicarMetricas(guild, ids, { categoria });
  return { ok: true, categoria, ids, ...resultado };
}

async function desactivar(guild, { borrar = true } = {}) {
  const canales = configDe(guild.id).canales ?? {};
  const borrados = [];
  const fallidos = [];

  for (const [id, canalId] of Object.entries(canales)) {
    const canal = guild.channels.cache.get(canalId);
    limpiarCola(canalId);
    if (!borrar || !canal) continue;
    try {
      await canal.delete(MOTIVO);
      borrados.push({ id, canal });
    } catch (error) {
      fallidos.push({ id, motivo: error.message });
    }
  }

  // Se conserva la categoría y las métricas elegidas: volver a activar los recrea igual.
  guardar(guild.id, { activado: false, canales: borrar ? {} : { ...canales }, actualizado: Date.now() });
  ultimasPasadas.delete(guild.id);
  return { borrados, fallidos, total: Object.keys(canales).length };
}

// ---------- Refresco ----------

// Revisa los números de UN servidor y deja los renombres encolados o aplicados.
async function refrescarGuild(guild, { guardarPasada = true } = {}) {
  if (!activo(guild.id)) return { ok: false, motivo: 'no-activo', resultados: [] };

  const resultados = [];
  for (const id of metricasActivas(guild.id)) {
    const canal = guild.channels.cache.get(canalIdDe(guild.id, id));
    if (!canal) {
      resultados.push({ id, estado: 'perdido' });
      continue;
    }
    const objetivo = nombreDeMetrica(id, valorDeMetrica(guild, id));
    const resultado = await encolarRenombre(guild, canal, objetivo);
    resultados.push({ id, actual: canal.name, objetivo, ...resultado });
  }

  if (guardarPasada) {
    ultimasPasadas.set(guild.id, {
      cuando: Date.now(),
      resultados,
      renombrados: resultados.filter((r) => r.estado === 'renombrado').length,
      fallidos: resultados.filter((r) => r.estado === 'rechazado' || r.estado === 'perdido').length,
    });
  }

  return { ok: true, resultados };
}

// Pasada general (la llama index.js cada 10 minutos).
async function refrescar(client) {
  const resumen = { guilds: 0, renombrados: 0, espera: 0, fallidos: 0, sinCambio: 0 };
  for (const guild of client?.guilds?.cache?.values() ?? []) {
    if (!activo(guild.id)) continue;
    resumen.guilds += 1;
    const { resultados } = await refrescarGuild(guild);
    for (const r of resultados) {
      if (r.estado === 'renombrado') resumen.renombrados += 1;
      else if (r.estado === 'espera') resumen.espera += 1;
      else if (r.estado === 'sin-cambio') resumen.sinCambio += 1;
      else resumen.fallidos += 1;
    }
  }
  return resumen;
}

// ---------- Diagnóstico (lo lee /stats estado y la vigilancia, una sola fuente) ----------
function diagnosticoStats(guild) {
  const problemas = [];
  if (!activo(guild.id)) return problemas;

  const ids = metricasActivas(guild.id);
  const faltantes = ids.filter((id) => !guild.channels.cache.get(canalIdDe(guild.id, id)));
  if (faltantes.length) {
    problemas.push({
      nivel: 'aviso',
      texto: `Faltan ${faltantes.length} canal(es) de estadísticas (${faltantes.join(', ')}): alguien los borró. \`/stats metricas\` los recrea.`,
    });
  }

  if (ids.includes('enLinea') && !censo.tienePresencias(guild.client)) {
    problemas.push({
      nivel: 'aviso',
      texto:
        'El canal «En línea» está sin datos: el bot no pide el Presence Intent, así que Discord no le manda quién está conectado. ' +
        'Habilitalo en el portal (o quitá esa métrica con `/stats metricas`).',
    });
  }

  const pasada = ultimasPasadas.get(guild.id);
  const rechazados = pasada?.resultados?.filter((r) => r.estado === 'rechazado') ?? [];
  if (rechazados.length) {
    problemas.push({
      nivel: 'aviso',
      texto: `La última pasada no pudo renombrar ${rechazados.length} canal(es) de estadísticas (${rechazados
        .map((r) => r.id)
        .join(', ')}): revisá el permiso **Gestionar canales** del bot.`,
    });
  }

  return problemas;
}

function ultimaPasada(guildId) {
  return ultimasPasadas.get(guildId) ?? null;
}

// Limpieza para los tests (y para desactivar del todo): colas y pasadas en memoria.
function reiniciar() {
  for (const canalId of [...colas.keys()]) limpiarCola(canalId);
  ultimasPasadas.clear();
}

module.exports = {
  METRICAS,
  SIN_DATO,
  INTERVALO_MS,
  RENOMBRES_POR_VENTANA,
  VENTANA_RENOMBRE_MS,
  NOMBRE_CATEGORIA,
  metrica,
  idsValidos,
  metricasPorDefecto,
  normalizarMetricas,
  nombreDeMetrica,
  valorDeMetrica,
  configDe,
  activo,
  metricasActivas,
  canalIdDe,
  activar,
  cambiarMetricas,
  desactivar,
  refrescar,
  refrescarGuild,
  diagnosticoStats,
  ultimaPasada,
  reiniciar,
};
