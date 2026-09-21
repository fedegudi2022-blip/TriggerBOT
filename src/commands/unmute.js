const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../store');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Le quita el silencio a un usuario')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a des-silenciar').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del des-silencio').setMaxLength(500)),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const error = motivoNoModerable(interaction, member);
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    const muteRole = getGuildConfig(interaction.guild.id).muteRole;
    if (!muteRole || !member.roles.cache.has(muteRole)) {
      return interaction.reply({ embeds: [errorEmbed(`${user} no está silenciado con el rol de silenciado.`)], flags: MessageFlags.Ephemeral });
    }

    await member.roles.remove(muteRole, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`);
    await avisarPorDM(user, `🔊 Ya no estás silenciado en **${interaction.guild.name}**. ¡Bienvenido de vuelta!`);

    await interaction.reply({
      embeds: [successEmbed(`${user} puede volver a hablar.`)],
    });

    logAction(interaction.guild, {
      action: 'Des-silencio (unmute)',
      color: 0x57f287,
      target: user,
      moderator: interaction.user,
      reason,
    });
  },
};
