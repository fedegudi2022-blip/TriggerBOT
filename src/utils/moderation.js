// Chequeos compartidos por los comandos de moderación.

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

// Intenta enviar un DM; ignora el error si el usuario tiene los DMs cerrados.
async function avisarPorDM(user, texto) {
  await user.send(texto).catch(() => {});
}

module.exports = { motivoNoModerable, avisarPorDM };
