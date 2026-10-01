// Autorización de staff unificada para TODO el bot.
//
// Antes cada comando repetía su propio chequeo con una política distinta: unos
// aceptaban ManageGuild, otros ModerateMembers, otros ManageChannels, y casi todos
// armaban la lista de roles admin/mod/helper a mano. Eso hacía que Discord ocultara
// el comando a un helper configurado por rol, aunque el bot lo hubiera aceptado.
//
// La regla de este servidor es una sola:
//   · El staff es el dueño del servidor, quien tenga ManageGuild, o quien tenga
//     alguno de los roles admin/mod/helper configurados en /config.
//   · Los comandos declaran en Discord SIN permiso nativo y validan acá: cualquier
//     nivel de staff configurado habilita, y el permiso nativo de Discord queda como
//     respaldo para quien ya lo tenía.
const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../store');
const { errorEmbed } = require('./replies');

// Niveles de staff, de mayor a menor: quien tenga varios roles cuenta como el más alto.
const NIVELES = ['admin', 'mod', 'helper'];

// Nivel de staff de un miembro, o null si no es staff.
function nivelDe(guild, member) {
  if (!member) return null;
  if (guild?.ownerId === member.id) return 'admin';
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return 'admin';
  const config = getGuildConfig(guild?.id);
  for (const nivel of NIVELES) {
    const rol = config[`${nivel}Role`];
    if (rol && member.roles?.cache?.has?.(rol)) return nivel;
  }
  return null;
}

function nivelStaff(interaction) {
  return nivelDe(interaction.guild, interaction.member);
}

// ¿Es staff (cualquier nivel)?
function esStaff(interaction) {
  return nivelStaff(interaction) !== null;
}

// ¿Es admin? (dueño, ManageGuild o rol admin configurado)
function esAdmin(interaction) {
  return nivelStaff(interaction) === 'admin';
}

// Variante sin interacción (acciones de IA, botones, voz, tickets).
function esStaffDe(guild, member) {
  return nivelDe(guild, member) !== null;
}

// Autorización de un comando: staff configurado O el permiso nativo de Discord.
// `permisoNativo` es el mismo que antes se declaraba en setDefaultMemberPermissions.
function autorizado(interaction, permisoNativo = null) {
  if (nivelStaff(interaction) !== null) return true;
  if (!permisoNativo) return false;
  return Boolean(interaction.member?.permissions?.has?.(permisoNativo));
}

// Igual que `autorizado` pero para contextos sin interacción.
function autorizadoDe(guild, member, permisoNativo = null) {
  if (nivelDe(guild, member) !== null) return true;
  if (!permisoNativo) return false;
  return Boolean(member?.permissions?.has?.(permisoNativo));
}

// Guard estándar de los comandos: si el usuario no está autorizado (staff por
// política interna o el permiso nativo de respaldo), responde efímero con un
// mensaje uniforme y devuelve false. Así cada comando declara UNA línea y la
// política (roles configurados + permiso nativo) vive en un solo lugar.
//
// Uso:
//   if (!(await exigirStaff(interaction, PermissionFlagsBits.ModerateMembers))) return;
async function exigirStaff(interaction, permisoNativo = null, descripcion = 'Esta acción es solo para el staff.') {
  if (autorizado(interaction, permisoNativo)) return true;
  await interaction.reply({ embeds: [errorEmbed(descripcion, 'Solo staff')], flags: MessageFlags.Ephemeral });
  return false;
}

module.exports = { NIVELES, nivelDe, nivelStaff, esStaff, esAdmin, esStaffDe, autorizado, autorizadoDe, exigirStaff };
