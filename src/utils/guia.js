// Guía del bot. Se arma a partir de los comandos REALMENTE cargados
// (`client.commands`), no de una lista escrita a mano: antes, cada vez que se
// agregaba o renombraba un comando, la guía quedaba desactualizada en silencio.
//
// Hay dos versiones: la pública (que ven todos con /help) y la de staff (completa,
// solo con /help staff). Cada categoría aporta su texto; los comandos que no estén
// en ninguna categoría se listan igual, en «Otros», así nunca desaparecen de la guía.
const { brandEmbed, COLORS } = require('./replies');

// Comandos que solo puede usar el staff: no se muestran en la guía pública.
const SOLO_STAFF = new Set([
  'ban',
  'unban',
  'softban',
  'kick',
  'warn',
  'warnings',
  'quitarnota',
  'timeout',
  'mute',
  'unmute',
  'clear',
  'lockdown',
  'slowmode',
  'config',
  'rolnivel',
  'voz',
  'ticket',
  'embed',
  'plantillas',
  'frases',
  'diag',
  'buscar',
]);

// ---------- Categorías públicas ----------
const CATEGORIAS_PUBLICAS = [
  {
    nombre: 'Información',
    comandos: ['help', 'ping', 'status', 'userinfo', 'serverinfo', 'avatar'],
    nota: '*`/ping` y `/status` tienen botón de refrescar, sin reescribir el comando.*',
  },
  {
    nombre: 'Comunidad',
    comandos: ['redes', 'web'],
    intro: '`/redes` · `/web` — redes sociales oficiales (WhatsApp, Steam, Instagram) y el sitio triggerarena.pro, con botones directos.',
    nota: 'En el canal «➕ Crear canal» tenés **canales de voz temporales**: entrás y se te crea tu propio canal con controles (cerrar, renombrar, límite, expulsar). Se borra solo cuando queda vacío.',
  },
  {
    nombre: 'Servidores CS 1.6',
    comandos: ['servidores', 'ip'],
    intro: '`/servidores` · `/ip` — estado en vivo, mapa actual e IP para copiar.',
  },
  {
    nombre: 'Niveles y logros',
    comandos: ['estadisticas', 'logros', 'top'],
    intro: 'Ganás XP escribiendo: la racha suma bonus, los findes es x2 y los logros pagan XP.',
    nota: '*`/top` tiene podio y páginas con botones; `/logros` te muestra cuánto falta para cada uno.*',
  },
  {
    nombre: 'Utilidades',
    comandos: ['afk', 'encuesta'],
  },
  {
    nombre: 'Diversión',
    comandos: ['dado', 'moneda', 'meme', '8ball', 'beso', 'abrazo', 'caricia', 'abofetear', 'morder', 'pellizco', 'chocar', 'guino'],
    intro: 'Juegos rápidos y comandos de interacción con GIFs y contadores.',
  },
];

// ---------- Categorías de staff ----------
const CATEGORIAS_STAFF = [
  {
    nombre: 'Moderación',
    comandos: ['warn', 'warnings', 'quitarnota', 'kick', 'ban', 'unban', 'softban', 'timeout', 'mute', 'unmute', 'clear', 'lockdown', 'slowmode'],
    nota: '*Además: anti-spam y anti-raid automáticos (se prenden en `/config`).*',
  },
  {
    nombre: 'Configuración',
    comandos: ['config', 'rolnivel', 'ticket', 'voz', 'frases'],
    intro: '`/config` abre el panel interactivo con todas las secciones del servidor.',
    nota: '`/diag` revisa todo el bot y dice qué está roto y qué hacer: si algo se degrada, el bot también avisa solo en el canal de avisos.',
  },
  {
    nombre: 'Diagnóstico y búsqueda',
    comandos: ['diag', 'buscar'],
    intro: '`/diag` revisa los sistemas (incluida la salida a internet).`/buscar` muestra qué encuentra la IA en la web, con fuentes.',
  },
  {
    nombre: 'Mensajes y utilidades internas',
    comandos: ['embed', 'plantillas'],
    intro: '`/embed` publica anuncios; `/plantillas` administra los motivos rápidos de sanción.',
  },
  {
    nombre: 'Panel de servidores CS 1.6',
    comandos: ['servidores'],
    nota: '`/servidores → publicar` deja el panel que se actualiza solo cada 90 s.',
  },
];

// Arma el valor de un campo a partir de los comandos reales de esa categoría.
// Si un comando de la lista ya no existe, se omite; si existe y no está en ninguna
// categoría, se agrega al final (ver «Otros»).
function valorDeCategoria(client, categoria, usados) {
  const lineas = [];
  if (categoria.intro) lineas.push(categoria.intro);

  const nombres = categoria.comandos.filter((nombre) => client.commands.has(nombre));
  if (nombres.length) {
    const lista = nombres.map((nombre) => {
      usados.add(nombre);
      return `\`/${nombre}\``;
    });
    lineas.push(lista.join(' · '));
  }

  if (categoria.nota) lineas.push(categoria.nota);
  return lineas.join('\n');
}

// Campos de las categorías indicadas, más «Otros» con lo que quedó sin clasificar.
function campos(client, categorias, usados) {
  const salida = [];
  for (const categoria of categorias) {
    const valor = valorDeCategoria(client, categoria, usados);
    if (valor.trim()) salida.push({ name: categoria.nombre, value: valor });
  }
  return salida;
}

// Comandos cargados que no figuran en ninguna categoría: se listan igual para que
// la guía nunca quede incompleta. En la pública se omiten los de staff.
function campoOtros(client, usados, { incluirStaff = true } = {}) {
  const restantes = [...client.commands.keys()].filter((nombre) => !usados.has(nombre) && (incluirStaff || !SOLO_STAFF.has(nombre)));
  if (!restantes.length) return null;
  return {
    name: 'Otros',
    value: restantes
      .sort()
      .map((n) => `\`/${n}\``)
      .join(' · '),
  };
}

// Guía pública: la ve cualquiera con /help. Sin comandos de staff.
function construirGuia(client) {
  const usados = new Set();
  const fields = campos(client, CATEGORIAS_PUBLICAS, usados);

  // Lo que no sea de staff y haya quedado sin categoría también se muestra.
  const otros = campoOtros(client, usados, { incluirStaff: false });
  if (otros) fields.push(otros);

  return brandEmbed({
    color: COLORS.info,
    title: `Hola! Soy ${client.user.username}`,
    description: 'Bot de la comunidad Trigger. Acá tenés lo que podés usar, por categoría:',
    fields,
    footer: 'TriggerBOT • usá /help cuando necesites la guía',
  });
}

// Guía completa: todo lo de la pública + todo lo de staff. Solo con /help staff.
function construirGuiaStaff(client) {
  const usados = new Set();
  const fields = campos(client, CATEGORIAS_PUBLICAS, usados);
  fields.push(...campos(client, CATEGORIAS_STAFF, usados));

  const otros = campoOtros(client, usados);
  if (otros) fields.push(otros);

  return brandEmbed({
    color: COLORS.info,
    title: `Guía completa de ${client.user.username} (staff)`,
    description: 'Todo lo que sé hacer, incluida la parte de moderación y configuración:',
    fields,
    footer: 'TriggerBOT • guía de staff, no la compartas en canales públicos',
  });
}

module.exports = { construirGuia, construirGuiaStaff, CATEGORIAS_PUBLICAS, CATEGORIAS_STAFF, SOLO_STAFF };
