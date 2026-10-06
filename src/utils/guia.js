// Guía del bot, armada a partir de los comandos REALMENTE cargados (`client.commands`).
//
// Hay dos versiones: la pública y la de staff (completa). Cada categoría aporta su lista
// de comandos y, si hace falta, UNA línea corta de contexto. Las listas se generan solas:
// la guía no puede quedar desactualizada cuando se agrega o renombra un comando.
//
// ---------- Qué es público y qué es de staff ----------
// La guía pública muestra SOLO los comandos de las categorías públicas; todo lo demás es
// de staff. Antes había una lista negra escrita a mano (`SOLO_STAFF`, 25 nombres) y la
// regla estaba al revés: un comando de staff nuevo aparecía en la guía pública hasta que
// alguien se acordaba de sumarlo. Con esta regla el olvido es seguro: si no está en una
// categoría pública (o no declara `publico: true`), no se muestra.
// `tests/guia.test.js` fija las dos mitades: ningún comando de staff se filtra y ningún
// comando público desaparece.
const { PermissionsBitField } = require('discord.js');
const { brandEmbed, COLORS } = require('./replies');

// ---------- Categorías públicas ----------
// Esta lista es la declaración de qué puede usar cualquiera. Sumar un comando público es
// sumarlo acá; no hay ningún otro lugar que mantener.
const CATEGORIAS_PUBLICAS = [
  {
    nombre: 'Información',
    comandos: ['help', 'ping', 'status', 'userinfo', 'serverinfo', 'avatar'],
  },
  {
    nombre: 'Comunidad',
    comandos: ['redes', 'web'],
    nota: 'Los canales de voz temporales se crean solos al entrar a «Crear canal».',
  },
  {
    nombre: 'Servidores CS 1.6',
    comandos: ['servidores', 'ip', 'jugadores'],
  },
  {
    nombre: 'Niveles y logros',
    comandos: ['estadisticas', 'logros', 'top'],
    nota: 'Ganás XP escribiendo (máx. 1 mensaje por minuto); la racha suma bonus y los findes es x2.',
  },
  {
    nombre: 'Utilidades',
    comandos: ['afk', 'encuesta', 'reportar'],
  },
  {
    nombre: 'Diversión',
    comandos: ['dado', 'moneda', 'meme', '8ball', 'beso', 'abrazo', 'caricia', 'abofetear', 'morder', 'pellizco', 'chocar', 'guino'],
  },
];

// ---------- Categorías de staff ----------
// Un comando que ya salió en una categoría pública no se repite acá: `/servidores`, por
// ejemplo, aparecía dos veces en la guía de staff (una por cada lista).
const CATEGORIAS_STAFF = [
  {
    nombre: 'Moderación',
    comandos: [
      'warn',
      'warnings',
      'unwarn',
      'nota',
      'casos',
      'logs',
      'sanciones',
      'kick',
      'ban',
      'tempban',
      'unban',
      'softban',
      'timeout',
      'mute',
      'unmute',
      'clear',
      'lockdown',
      'slowmode',
    ],
    nota: 'Los baneos temporales se levantan solos al vencer y cada acción queda en el mod-log con número de caso.',
  },
  {
    nombre: 'Configuración',
    comandos: ['config', 'bienvenida', 'rolnivel', 'ticket', 'voz', 'frases'],
    nota: 'Desde el panel se prenden el anti-spam, el anti-raid y la escalada de advertencias.',
  },
  {
    nombre: 'Diagnóstico',
    comandos: ['diag', 'buscar'],
    nota: 'Los dos salen a internet a propósito: el diagnóstico prueba la salida del host.',
  },
  {
    nombre: 'Mensajes internos',
    comandos: ['embed', 'plantillas'],
  },
  {
    nombre: 'Panel de servidores CS 1.6',
    comandos: [],
    nota: 'El panel se publica una vez y se actualiza solo cada 90 s.',
  },
];

// Nombres declarados públicos. Es la única fuente de verdad de la visibilidad.
const NOMBRES_PUBLICOS = new Set(CATEGORIAS_PUBLICAS.flatMap((c) => c.comandos));

// ¿Lo puede usar cualquiera? Sí si está en una categoría pública o si el comando declara
// `publico: true`. Todo lo demás es de staff.
function esPublico(comando) {
  if (!comando?.data?.name) return false;
  return comando.publico === true || NOMBRES_PUBLICOS.has(comando.data.name);
}

// Un comando de menú contextual (click derecho sobre un usuario) NO es "/comando": la guía
// y el catálogo de la IA solo listan slash. La respuesta vive en un solo lado para que la
// guía y la IA no se desincronicen.
function esSlash(comando) {
  return (comando?.data?.toJSON?.().type ?? 1) === 1;
}

// Valor de un campo: los comandos de esa categoría en un renglón y, si la categoría la
// tiene, una nota corta debajo. La nota es SIEMPRE una línea aparte: antes el texto de
// intro repetía la lista ("/redes · /web — redes sociales…") y después la lista aparecía
// otra vez, así que la guía decía lo mismo dos veces.
function valorDeCategoria(client, categoria, usados) {
  const nombres = (categoria.comandos ?? []).filter((nombre) => client.commands.has(nombre) && !usados.has(nombre));
  for (const nombre of nombres) usados.add(nombre);

  const lineas = [];
  if (nombres.length) lineas.push(nombres.map((nombre) => `\`/${nombre}\``).join(' · '));
  if (categoria.nota) lineas.push(categoria.nota);
  return lineas.join('\n');
}

// Campos de las categorías indicadas. Una categoría sin comandos y sin nota no se muestra.
function campos(client, categorias, usados) {
  const salida = [];
  for (const categoria of categorias) {
    const valor = valorDeCategoria(client, categoria, usados);
    if (valor.trim()) salida.push({ name: categoria.nombre, value: valor });
  }
  return salida;
}

// Comandos cargados que no figuran en ninguna categoría: se listan igual, en «Otros», para
// que la guía de staff nunca quede incompleta. En la pública solo entran los que declaran
// `publico: true`: un comando sin declarar es de staff.
function campoOtros(client, usados, { soloPublicos = false } = {}) {
  const restantes = [...client.commands.values()]
    .filter(esSlash)
    .filter((comando) => !usados.has(comando.data.name))
    .filter((comando) => !soloPublicos || comando.publico === true)
    .map((comando) => comando.data.name);
  if (!restantes.length) return null;
  return {
    name: 'Otros',
    value: restantes
      .sort()
      .map((nombre) => `\`/${nombre}\``)
      .join(' · '),
  };
}

// Guía pública: la ve cualquiera con /help.
function construirGuia(client) {
  const usados = new Set();
  const fields = campos(client, CATEGORIAS_PUBLICAS, usados);

  const otros = campoOtros(client, usados, { soloPublicos: true });
  if (otros) fields.push(otros);

  return brandEmbed({
    color: COLORS.info,
    title: `Hola! Soy ${client.user.username}`,
    description: 'Lo que podés usar, por categoría:',
    fields,
    footer: 'TriggerBOT • /help user comando para ver el detalle de uno',
  });
}

// Guía completa: todo lo de la pública + todo lo de staff. Solo con /help staff.
function construirGuiaStaff(client) {
  const usados = new Set();
  const fields = campos(client, CATEGORIAS_PUBLICAS, usados);
  fields.push(...campos(client, CATEGORIAS_STAFF, usados));

  // Acá entran todos: es la guía que tiene que estar completa siempre.
  const otros = campoOtros(client, usados);
  if (otros) fields.push(otros);

  return brandEmbed({
    color: COLORS.info,
    title: `Guía completa de ${client.user.username} (staff)`,
    fields,
    footer: 'TriggerBOT • guía de staff, no la compartas en canales públicos',
  });
}

// ---------- Detalle de un comando (para /help <comando>) ----------
// Traduce los nombres de permiso de Discord a etiquetas en español. Lo que no esté acá se
// muestra con su nombre técnico: mejor que decir "requiere permisos" a secas.
const PERMISOS_ES = {
  BanMembers: 'Banear miembros',
  KickMembers: 'Expulsar miembros',
  ModerateMembers: 'Moderar miembros',
  ManageMessages: 'Gestionar mensajes',
  ManageChannels: 'Gestionar canales',
  ManageRoles: 'Gestionar roles',
  ManageGuild: 'Gestionar servidor',
};

// Permisos declarados en el comando (payload real), o null si no declara ninguno.
function permisosDeComando(json) {
  if (json.default_member_permissions == null) return null;
  try {
    return new PermissionsBitField(BigInt(json.default_member_permissions)).toArray();
  } catch {
    return null;
  }
}

// Resumen de acceso de un comando: permiso declarado, staff por política interna, o todos.
function accesoDeComando(client, nombre, json) {
  const permisos = permisosDeComando(json);
  if (permisos?.length) return `Solo con permiso de **${permisos.map((p) => PERMISOS_ES[p] ?? p).join(', ')}**.`;
  if (!esPublico(client.commands.get(nombre))) return '**Solo staff** (el bot decide por ManageGuild o los roles de `/config`).';
  return '**Todos** los miembros.';
}

// Embed con el detalle de un comando: para qué sirve, quién puede usarlo y sus opciones.
// Devuelve null si el comando no existe.
function detalleDeComando(client, nombre) {
  const comando = client.commands.get(nombre);
  if (!comando) return null;
  const json = comando.data.toJSON();

  const opciones = (json.options ?? []).map((o) => `\`${o.name}\`${o.required ? ' *(obligatorio)*' : ''} — ${o.description}`).join('\n');

  const fields = [{ name: 'Quién puede usarlo', value: accesoDeComando(client, nombre, json), inline: false }];
  if (opciones) fields.push({ name: 'Opciones', value: opciones.slice(0, 1024), inline: false });

  return brandEmbed({
    color: COLORS.info,
    title: `/${nombre}`,
    description: json.description,
    fields,
  });
}

module.exports = {
  esSlash,
  esPublico,
  construirGuia,
  construirGuiaStaff,
  detalleDeComando,
  CATEGORIAS_PUBLICAS,
  CATEGORIAS_STAFF,
  NOMBRES_PUBLICOS,
};
