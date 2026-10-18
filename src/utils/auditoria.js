// Auditoría de cambios de configuración.
//
// Por qué existe: el panel de /config guardaba los cambios sin dejar rastro. Si alguien
// prendía el anti-spam, cambiaba el canal de logs o desactivaba los tickets, no había
// forma de saber quién lo hizo ni cuándo. Acá se compara la config ANTES y DESPUÉS de
// cada guardado y se manda al canal de logs (o al de avisos, como respaldo) un embed con
// solo lo que cambió.
//
// Las claves de estado vivo (tickets abiertos, encuestas pendientes, calificaciones,
// historial de cierres y contador) se ignoran a propósito: cambian solas con el uso y
// llenarían el registro de ruido que no es una decisión de nadie.

const { EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../store');
const { COLORS } = require('./replies');
const crearLogger = require('../logger');

const log = crearLogger('auditoria');

// Rutas que NO son configuración: son estado que el bot mueve solo.
const IGNORADAS = [
  'tickets.activos',
  'tickets.encuestas',
  'tickets.calificaciones',
  'tickets.cierres',
  'tickets.contador',
  'servidores.estado',
  'servidores.ultimoAviso',
];

function esObjeto(valor) {
  return Boolean(valor) && typeof valor === 'object' && !Array.isArray(valor);
}

// Copia profunda de la config para poder comparar contra el estado anterior. La config
// es JSON puro (sin funciones ni ciclos): JSON.parse(JSON.stringify(...)) alcanza.
function copiar(config) {
  return JSON.parse(JSON.stringify(config ?? {}));
}

function ignorada(ruta) {
  return IGNORADAS.some((clave) => ruta === clave || ruta.startsWith(`${clave}.`));
}

// Diferencias recursivas entre dos configuraciones. Devuelve [{ ruta, antes, despues }]
// con la ruta en formato `tickets.canalLogs`. Los objetos vacíos no cuentan como cambio
// si el otro lado tampoco existe.
function diferencias(antes, despues, prefijo = '') {
  const cambios = [];
  const claves = new Set([...Object.keys(antes ?? {}), ...Object.keys(despues ?? {})]);

  for (const clave of claves) {
    const ruta = prefijo ? `${prefijo}.${clave}` : clave;
    if (ignorada(ruta)) continue;
    const a = antes?.[clave];
    const d = despues?.[clave];

    if (esObjeto(a) && esObjeto(d)) {
      cambios.push(...diferencias(a, d, ruta));
    } else if (esObjeto(a) || esObjeto(d)) {
      // Un objeto contra undefined (o al revés): se resume; el detalle interno no
      // aporta si la sección entera aparece o desaparece.
      cambios.push({ ruta, antes: a, despues: d });
    } else if (JSON.stringify(a) !== JSON.stringify(d)) {
      cambios.push({ ruta, antes: a, despues: d });
    }
  }

  // El orden de Object.keys no es semántico: se ordena para que el registro se lea
  // igual siempre y los tests no dependan del orden de inserción.
  return cambios.sort((x, y) => x.ruta.localeCompare(y.ruta));
}

// Un valor de config convertido a algo legible en Discord. Los IDs de canal y rol se
// muestran como menciones (se ven con nombre); el resto se recorta para que un texto
// largo no ocupe medio embed.
function formatearValor(valor, guild) {
  if (valor === undefined || valor === null || valor === '') return '*sin configurar*';
  if (valor === true) return 'sí';
  if (valor === false) return 'no';

  if (typeof valor === 'string') {
    // Primero se busca el ID en la caché: si existe, la mención se ve con nombre. En
    // producción los IDs son snowflakes, pero mirar la caché también cubre tests y
    // cualquier ID válido que no siga el formato esperado.
    if (guild?.channels?.cache?.has?.(valor)) return `<#${valor}>`;
    if (guild?.roles?.cache?.has?.(valor)) return `<@&${valor}>`;
    const texto = valor.replace(/\s+/g, ' ').trim();
    return texto.length > 180 ? `${texto.slice(0, 177)}…` : texto;
  }

  if (Array.isArray(valor)) {
    if (!valor.length) return '*lista vacía*';
    if (valor.every((v) => typeof v === 'string' || typeof v === 'number')) {
      const texto = valor.slice(0, 8).join(', ');
      return valor.length > 8 ? `${texto}… (${valor.length})` : texto;
    }
    return `${valor.length} elemento(s)`;
  }

  if (typeof valor === 'object') return `${Object.keys(valor).length} campo(s)`;
  return String(valor);
}

function lineaCambio(cambio, guild) {
  return `• \`${cambio.ruta}\`: ${formatearValor(cambio.antes, guild)} → **${formatearValor(cambio.despues, guild)}**`;
}

function descripcionCambios(cambios, guild, limite = 10) {
  const lineas = cambios.slice(0, limite).map((c) => lineaCambio(c, guild));
  if (cambios.length > limite) lineas.push(`… y ${cambios.length - limite} cambio(s) más`);
  return lineas.join('\n');
}

// Canal del registro de configuración: el de logs es el natural; si no está, mod-log y
// avisos sirven para no perder el evento.
function canalDeAuditoria(guild) {
  const config = getGuildConfig(guild.id);
  const canalId = config.logs || config.modlog || config.avisosChannel;
  if (!canalId) return null;
  return guild.channels?.cache?.get(canalId) ?? null;
}

async function registrarCambioConfig({ guild, actor, seccion, antes, despues }) {
  const cambios = diferencias(antes, despues);
  if (!cambios.length) return { cambios: [], enviado: false };

  const canal = canalDeAuditoria(guild);
  if (!canal) return { cambios, enviado: false };

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('Configuración modificada')
    .setDescription(descripcionCambios(cambios, guild))
    .addFields(
      { name: 'Sección', value: seccion || 'sin identificar', inline: true },
      { name: 'Cambios', value: String(cambios.length), inline: true }
    )
    .setFooter({ text: `TriggerBOT • auditoría de /config${actor ? ` • ${actor.tag ?? actor.username ?? actor.id}` : ''}` })
    .setTimestamp();

  if (actor?.id) embed.setAuthor({ name: actor.tag ?? actor.username ?? actor.id, iconURL: actor.displayAvatarURL?.({ size: 128 }) });

  const enviado = await canal
    .send({ embeds: [embed], allowedMentions: { parse: [] } })
    .then(() => true)
    .catch((error) => {
      log.warn(`No pude registrar un cambio de configuración: ${error.message}`, { guild: guild.id, seccion });
      return false;
    });

  return { cambios, enviado };
}

// Guarda un cambio del panel y lo audita. Devuelve la promesa del envío para que los
// tests puedan esperarla; los handlers del panel no la esperan (no deben hacer esperar
// al staff por un mensaje de log).
function guardarConfigAuditada(interaction, seccion, mutar) {
  const guild = interaction.guild;
  const antes = copiar(getGuildConfig(guild.id));
  require('../store').setGuildConfig(guild.id, mutar);
  const despues = copiar(getGuildConfig(guild.id));

  return registrarCambioConfig({
    guild,
    actor: interaction.user,
    seccion,
    antes,
    despues,
  }).catch((error) => {
    log.warn(`No pude auditar el cambio de configuración: ${error.message}`, { guild: guild.id, seccion });
    return { cambios: [], enviado: false };
  });
}

module.exports = {
  diferencias,
  formatearValor,
  descripcionCambios,
  canalDeAuditoria,
  registrarCambioConfig,
  guardarConfigAuditada,
  IGNORADAS,
};
