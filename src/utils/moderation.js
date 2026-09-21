// Chequeos compartidos por los comandos de moderación y por las acciones de IA.
//
// motivoNoModerable(interaction, member): jerarquía moderador→objetivo.
// validarAccionDelBot(guild, member, permiso): ¿el BOT puede ejecutar la acción?
// Son independientes: las acciones automáticas y de IA usan el segundo.

// Devuelve un mensaje de error si el moderador no puede actuar sobre el objetivo,
// o null si todo está bien. Exige que el target tenga un rol estrictamente inferior
// al del moderador (salvo que el moderador sea el dueño del servidor).
function motivoNoModerable(interaction, member) {
  if (!member) return 'Ese usuario no está en el servidor.';
  if (member.id === interaction.user.id) return 'No podés hacérselo a vos mismo.';
  if (member.id === interaction.client.user.id) return 'No pienso hacérmelo a mí mismo 😤';

  const esDueno = interaction.guild.ownerId === interaction.user.id;
  if (!esDueno && member.roles.highest.position >= interaction.member.roles.highest.position) {
    return 'No podés moderar a alguien con tu mismo rol o uno superior.';
  }
  return null;
}

// Devuelve un mensaje de error si el bot no puede actuar sobre `member` con el
// permiso concreto `permiso` (un PermissionFlagsBits.*), o null si puede.
// Valida: que exista, que no sea el bot mismo, que no sea el dueño del server,
// que el rol más alto del objetivo quede por debajo del del bot y que el bot
// tenga el permiso concreto necesario.
function validarAccionDelBot(guild, member, permiso) {
  const yo = guild.members.me;
  if (!yo) return 'No pude resolver mi propio miembro en el servidor.';
  if (!member) return 'Ese usuario no está en el servidor.';
  if (member.id === yo.id) return 'No pienso hacérmelo a mí mismo 😤';
  if (member.id === guild.ownerId) return 'No puedo moderar al dueño del servidor.';
  if (!yo.permissions.has(permiso)) return 'Me falta el permiso necesario para esa acción.';
  if (member.roles.highest.position >= yo.roles.highest.position) {
    return 'Mi rol más alto está por debajo o al mismo nivel del de ese usuario.';
  }
  return null;
}

// Intenta enviar un DM; ignora el error si el usuario tiene los DMs cerrados.
async function avisarPorDM(user, texto) {
  await user.send(texto).catch(() => {});
}

module.exports = { motivoNoModerable, validarAccionDelBot, avisarPorDM };
