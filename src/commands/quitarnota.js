const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getWarns, removeWarn } = require('../warns');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('quitarnota')
    .setDescription('Elimina una advertencia del historial de un usuario')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario al que quitar la advertencia').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('numero')
        .setDescription('Número de advertencia a quitar (ver /warnings)')
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption((o) => o.setName('razon').setDescription('Motivo de la eliminación').setMaxLength(500)),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const numero = interaction.options.getInteger('numero', true);
    const reason = interaction.options.getString('razon');

    const totalAntes = getWarns(interaction.guild.id, user.id).length;
    if (totalAntes === 0) {
      return interaction.reply({ embeds: [errorEmbed(`${user} no tiene advertencias registradas.`)], ephemeral: true });
    }
    if (numero > totalAntes) {
      return interaction.reply({
        embeds: [errorEmbed(`Solo tiene **${totalAntes}** advertencia(s). Mirá los números con /warnings.`)],
        ephemeral: true,
      });
    }

    const removed = removeWarn(interaction.guild.id, user.id, numero);
    await interaction.reply({
      embeds: [
        successEmbed(
          `Se quitó la advertencia **#${numero}** de ${user}.\n**Motivo original:** ${removed?.reason || '*sin especificar*'}\n` +
            `**Advertencias restantes:** ${totalAntes - 1}`
        ),
      ],
    });

    logAction(interaction.guild, {
      action: 'Advertencia eliminada',
      color: 0x57f287,
      target: user,
      moderator: interaction.user,
      reason: reason || 'Sin especificar',
      extra: `Se eliminó la advertencia #${numero} ("${removed?.reason || 'sin especificar'}"). Quedan ${totalAntes - 1}.`,
    });
  },
};
