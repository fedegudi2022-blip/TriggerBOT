const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulsa a un usuario del servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a expulsar').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo de la expulsión (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true)),

  async autocomplete(interaction) {
    return autocompletar(interaction);
  },

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const error = motivoNoModerable(interaction, member);
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    await avisarPorDM(user, `👢 Fuiste expulsado de **${interaction.guild.name}**.\n**Motivo:** ${reason || '*sin especificar*'}`);

    await member.kick(reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`);

    await interaction.reply({
      embeds: [successEmbed(`${user} fue expulsado.\n**Motivo:** ${reason || '*sin especificar*'}`, '👢 Expulsión')],
    });
    logAction(interaction.guild, {
      action: 'Expulsión (kick)',
      target: user,
      moderator: interaction.user,
      reason,
    });
  },
};
