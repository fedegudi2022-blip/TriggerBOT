const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getWarns, removeWarn } = require('../warns');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS, marcaTiempo } = require('../utils/replies');
const { quiereSilencioso, diferir } = require('../utils/acciones');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('quitarnota')
    .setDescription('Elimina una advertencia del historial de un usuario')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario al que quitar la advertencia').setRequired(true))
    .addIntegerOption((o) => o.setName('numero').setDescription('Número de advertencia a quitar (ver /warnings)').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo de la eliminación').setMaxLength(500))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const numero = interaction.options.getInteger('numero', true);
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);

    const warns = getWarns(interaction.guild.id, user.id);
    if (warns.length === 0) {
      return interaction.reply({ embeds: [errorEmbed(`${user} no tiene advertencias registradas.`)], flags: MessageFlags.Ephemeral });
    }
    if (numero > warns.length) {
      return interaction.reply({
        embeds: [errorEmbed(`Solo tiene **${warns.length}** advertencia(s). Mirá los números con /warnings.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    await diferir(interaction, silencioso);

    const removed = removeWarn(interaction.guild.id, user.id, numero);

    // Sin catch silencioso: si la advertencia no se borró, no se puede responder
    // "listo" (removeWarn devuelve undefined cuando el índice no existe).
    if (!removed) {
      return interaction.editReply({
        embeds: [errorEmbed(`No pude eliminar la advertencia #${numero}. Probá de nuevo con /warnings a mano.`, 'No se aplicó el cambio')],
      });
    }

    const restantes = warns.length - 1;
    const caso = logAction(interaction.guild, {
      action: 'Advertencia eliminada',
      color: COLORS.success,
      target: user,
      moderator: interaction.user,
      reason: reason || 'No especificado',
      extra: `Se eliminó la advertencia #${numero} ("${removed.reason || 'no especificado'}"). Quedan ${restantes}.`,
    });

    return interaction.editReply({
      embeds: [
        accionEmbed({
          titulo: '✅ Advertencia eliminada',
          detalle: `Se quitó la advertencia **#${numero}** de ${user}.`,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          thumbnail: user.displayAvatarURL({ size: 128 }),
          campos: [
            { name: 'Advertencia original', value: removed.reason || '*No especificado*', inline: false },
            {
              name: 'Registrada',
              value: removed.timestamp ? `${marcaTiempo(removed.timestamp, 'd')} por <@${removed.moderatorId}>` : '*sin fecha*',
              inline: false,
            },
            { name: 'Historial actual', value: `${restantes} advertencia(s) — ver /warnings`, inline: false },
          ],
          footer: reason ? `motivo de la eliminación: ${reason}` : undefined,
        }),
      ],
    });
  },
};
