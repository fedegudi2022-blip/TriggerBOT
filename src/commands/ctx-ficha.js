// Comando de menú contextual (click derecho sobre un usuario → Aplicaciones → Ficha de niveles).
// No tiene lógica propia: usa el mismo render que /estadisticas, así los dos no pueden
// mostrar cosas distintas.
const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const estadisticasCmd = require('./estadisticas');

module.exports = {
  data: new ContextMenuCommandBuilder().setName('Ficha de niveles').setType(ApplicationCommandType.User),

  async execute(interaction) {
    await interaction.deferReply();
    return estadisticasCmd.ejecutar(interaction, interaction.targetUser);
  },
};
