const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { quiereSilencioso, diferir, intentar } = require('../utils/acciones');

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
        .addChoices({ name: '🔒 Bloquear', value: 'bloquear' }, { name: '🔓 Desbloquear', value: 'desbloquear' })
    )
    .addChannelOption((o) =>
      o
        .setName('canal')
        .setDescription('Canal afectado (por defecto, el canal actual)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del bloqueo').setMaxLength(500))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async execute(interaction) {
    const accion = interaction.options.getString('accion', true);
    const channel = interaction.options.getChannel('canal') ?? interaction.channel;
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);
    const bloquear = accion === 'bloquear';

    if (!channel.manageable) {
      return interaction.reply({
        embeds: [errorEmbed(`No tengo permiso para gestionar <#${channel.id}>. Revisá mis permisos en ese canal.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    await diferir(interaction, silencioso);

    const resultado = await intentar(bloquear ? 'Discord rechazó el bloqueo' : 'Discord rechazó el desbloqueo', () =>
      channel.permissionOverwrites.edit(
        interaction.guild.roles.everyone,
        { SendMessages: bloquear ? false : null },
        reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`
      )
    );

    const etiqueta = bloquear ? 'Bloqueo de canal (lockdown)' : 'Desbloqueo de canal';
    const caso = logAction(interaction.guild, {
      action: resultado.ok ? etiqueta : `${etiqueta} — rechazado`,
      color: resultado.ok ? (bloquear ? COLORS.error : COLORS.success) : COLORS.warn,
      target: { raw: `Canal ${channel} (\`#${channel.name}\`)` },
      moderator: interaction.user,
      reason,
      extra: `Canal: <#${channel.id}>${resultado.ok ? '' : ` — ${resultado.error}`}`,
    });

    if (!resultado.ok) {
      return interaction.editReply({
        embeds: [errorEmbed(`No pude ${bloquear ? 'bloquear' : 'desbloquear'} <#${channel.id}>.\n> ${resultado.error}`, 'La acción no se aplicó')],
      });
    }

    return interaction.editReply({
      embeds: [
        accionEmbed({
          color: bloquear ? COLORS.error : COLORS.success,
          titulo: bloquear ? '🔒 Canal bloqueado' : '🔓 Canal desbloqueado',
          detalle: bloquear
            ? `**${channel}** quedó bloqueado: nadie de @everyone puede escribir hasta que lo desbloqueen.`
            : `**${channel}** fue desbloqueado: ya se puede volver a escribir.`,
          motivo: reason,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          footer: bloquear ? 'para reabrirlo: /lockdown accion:desbloquear' : undefined,
        }),
      ],
    });
  },
};
