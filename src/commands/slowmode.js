const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Configura el modo lento de un canal (0 para desactivarlo)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((o) =>
      o
        .setName('segundos')
        .setDescription('Segundos de espera entre mensajes (0-21600; máximo de Discord: 6 horas)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(21600)
    )
    .addChannelOption((o) =>
      o
        .setName('canal')
        .setDescription('Canal a configurar (por defecto, el canal actual)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del cambio').setMaxLength(500)),

  async execute(interaction) {
    const segundos = interaction.options.getInteger('segundos', true);
    const channel = interaction.options.getChannel('canal') ?? interaction.channel;
    const reason = interaction.options.getString('razon');

    if (!channel.manageable) {
      return interaction.reply({
        embeds: [errorEmbed(`No tengo permiso para gestionar <#${channel.id}>. Revisá mis permisos en ese canal.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    await channel.setRateLimitPerUser(segundos, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`);

    const texto =
      segundos === 0
        ? `⏱️ Modo lento **desactivado** en ${channel}.`
        : `⏱️ Modo lento de **${segundos}s** activado en ${channel}.`;

    await interaction.reply({ embeds: [successEmbed(texto, 'Modo lento')] });

    logAction(interaction.guild, {
      action: 'Modo lento (slowmode)',
      color: 0x5865f2,
      target: { raw: `Canal ${channel} (\`#${channel.name}\`)` },
      moderator: interaction.user,
      reason,
      extra: `Canal: <#${channel.id}> — ${segundos === 0 ? 'desactivado' : `${segundos}s de espera`}`,
    });
  },
};
