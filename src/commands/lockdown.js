const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Bloquea o desbloquea el envío de mensajes en un canal')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) =>
      o
        .setName('accion')
        .setDescription('Qué hacer con el canal')
        .setRequired(true)
        .addChoices(
          { name: '🔒 Bloquear', value: 'bloquear' },
          { name: '🔓 Desbloquear', value: 'desbloquear' }
        )
    )
    .addChannelOption((o) =>
      o
        .setName('canal')
        .setDescription('Canal afectado (por defecto, el canal actual)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del bloqueo').setMaxLength(500)),

  async execute(interaction) {
    const accion = interaction.options.getString('accion', true);
    const channel = interaction.options.getChannel('canal') ?? interaction.channel;
    const reason = interaction.options.getString('razon');
    const bloquear = accion === 'bloquear';

    if (!channel.manageable) {
      return interaction.reply({
        embeds: [errorEmbed(`No tengo permiso para gestionar <#${channel.id}>. Revisá mis permisos en ese canal.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    await channel.permissionOverwrites.edit(
      interaction.guild.roles.everyone,
      { SendMessages: bloquear ? false : null },
      reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`
    );

    await interaction.reply({
      embeds: [
        successEmbed(
          bloquear
            ? `🔒 **${channel}** quedó bloqueado. Nadie puede escribir hasta que lo desbloqueen.`
            : `🔓 **${channel}** fue desbloqueado. Ya se puede volver a escribir.`,
          bloquear ? 'Canal bloqueado' : 'Canal desbloqueado'
        ),
      ],
    });

    logAction(interaction.guild, {
      action: bloquear ? 'Bloqueo de canal (lockdown)' : 'Desbloqueo de canal',
      color: bloquear ? 0xed4245 : 0x57f287,
      target: { raw: `Canal ${channel} (\`#${channel.name}\`)` },
      moderator: interaction.user,
      reason,
      extra: `Canal: <#${channel.id}>`,
    });
  },
};
