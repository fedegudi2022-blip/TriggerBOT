const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Banea a un usuario del servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a banear').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del baneo (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true))
    .addIntegerOption((o) =>
      o
        .setName('borrar_dias')
        .setDescription('Borrar mensajes de los últimos X días (0-7)')
        .setMinValue(0)
        .setMaxValue(7)
    ),

  async autocomplete(interaction) {
    return autocompletar(interaction);
  },

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const deleteDays = interaction.options.getInteger('borrar_dias') ?? 0;
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    if (member) {
      const error = motivoNoModerable(interaction, member);
      if (error) {
        return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
      }
      if (!member.bannable) {
        return interaction.reply({
          embeds: [errorEmbed('No puedo banearlo: su rol está por encima del mío (o es el dueño del servidor).')],
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    await avisarPorDM(
      user,
      `⛔ Fuiste baneado de **${interaction.guild.name}**.\n**Motivo:** ${reason || '*sin especificar*'}`
    );

    await interaction.guild.members.ban(user.id, {
      deleteMessageSeconds: deleteDays * 86400,
      reason: reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`,
    });

    await interaction.reply({
      embeds: [
        successEmbed(
          `${user} fue baneado.${deleteDays > 0 ? `\n**Limpieza:** mensajes de los últimos ${deleteDays} día(s) borrados.` : ''}`,
          '🔨 Baneo'
        ),
      ],
    });
    logAction(interaction.guild, {
      action: 'Baneo (ban)',
      target: user,
      moderator: interaction.user,
      reason,
      extra: deleteDays > 0 ? `Se borraron sus mensajes de los últimos ${deleteDays} día(s).` : undefined,
    });
  },
};
