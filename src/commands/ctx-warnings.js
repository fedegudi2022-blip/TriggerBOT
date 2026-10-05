// Comando de menú contextual (click derecho sobre un usuario → Aplicaciones → Ver warnings).
// Delega en la misma vista que /warnings, que ya chequea el permiso y contesta en efímero.
const { ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits } = require('discord.js');
const warningsCmd = require('./warnings');

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Ver warnings')
    .setType(ApplicationCommandType.User)
    // Oculto en el menú para quien no modera. No reemplaza el chequeo del comando: los
    // permisos por defecto los puede cambiar un admin del server, y el bot igual
    // vuelve a verificar con exigirStaff().
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    return warningsCmd.ejecutar(interaction, interaction.targetUser, 1);
  },
};
