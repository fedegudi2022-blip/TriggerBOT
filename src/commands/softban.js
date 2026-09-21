const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('softban')
    .setDescription('Banea y desbanea al instante: expulsa al usuario borrando todos sus mensajes')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a expulsar con limpieza de mensajes').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('borrar_dias')
        .setDescription('Días de mensajes a borrar (0-7, por defecto 1)')
        .setMinValue(0)
        .setMaxValue(7)
    )
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del softban').setMaxLength(500)),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const deleteDays = interaction.options.getInteger('borrar_dias') ?? 1;
    const reason = interaction.options.getString('razon');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const error = motivoNoModerable(interaction, member);
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], ephemeral: true });
    }

    await avisarPorDM(user, `🧹 Fuiste expulsado de **${interaction.guild.name}** con limpieza de mensajes.\n**Motivo:** ${reason || '*sin especificar*'}`);

    await interaction.guild.members.ban(user.id, {
      deleteMessageSeconds: deleteDays * 86400,
      reason: `[softban] ${reason || 'sin especificar'} — por ${interaction.user.tag}`,
    });
    await interaction.guild.members.unban(user.id, `[softban] purga de mensajes — por ${interaction.user.tag}`);

    await interaction.reply({
      embeds: [successEmbed(`${user} fue expulsado con limpieza de **${deleteDays} día(s)** de mensajes. Puede volver a entrar cuando quiera.`)],
    });

    logAction(interaction.guild, {
      action: 'Expulsión con limpieza (softban)',
      color: 0xe67e22,
      target: user,
      moderator: interaction.user,
      reason,
      extra: `Se borraron sus mensajes de los últimos ${deleteDays} día(s).`,
    });
  },
};
