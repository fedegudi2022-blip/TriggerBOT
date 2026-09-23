const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, textoDuracion, COLORS } = require('../utils/replies');
const { quiereSilencioso, diferir, intentar } = require('../utils/acciones');

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
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del cambio').setMaxLength(500))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async execute(interaction) {
    const segundos = interaction.options.getInteger('segundos', true);
    const channel = interaction.options.getChannel('canal') ?? interaction.channel;
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);

    if (!channel.manageable) {
      return interaction.reply({
        embeds: [errorEmbed(`No tengo permiso para gestionar <#${channel.id}>. Revisá mis permisos en ese canal.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    const actual = channel.rateLimitPerUser ?? 0;
    if (actual === segundos) {
      return interaction.reply({
        embeds: [
          errorEmbed(
            segundos === 0
              ? `**${channel.name}** ya tiene el modo lento desactivado.`
              : `<#${channel.id}> ya tiene un modo lento de **${segundos}s**.`,
            'Sin cambios'
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    await diferir(interaction, silencioso);

    const resultado = await intentar('Discord rechazó el cambio de modo lento', () =>
      channel.setRateLimitPerUser(segundos, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`)
    );

    const caso = logAction(interaction.guild, {
      action: resultado.ok ? 'Modo lento (slowmode)' : 'Modo lento (slowmode) — rechazado',
      color: resultado.ok ? COLORS.info : COLORS.warn,
      target: { raw: `Canal ${channel} (\`#${channel.name}\`)` },
      moderator: interaction.user,
      reason,
      extra: `Canal: <#${channel.id}> — ${segundos === 0 ? 'desactivado' : `${segundos}s de espera`}${resultado.ok ? '' : ` — ${resultado.error}`}`,
    });

    if (!resultado.ok) {
      return interaction.editReply({
        embeds: [errorEmbed(`No pude cambiar el modo lento de <#${channel.id}>.\n> ${resultado.error}`, 'La acción no se aplicó')],
      });
    }

    return interaction.editReply({
      embeds: [
        accionEmbed({
          titulo: '⏱️ Modo lento',
          detalle:
            segundos === 0
              ? `Modo lento **desactivado** en ${channel}.`
              : `Modo lento de **${segundos}s** activado en ${channel} (${textoDuracion(segundos * 1000)} de espera entre mensajes).`,
          motivo: reason,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          campos: actual > 0 && segundos > 0 ? [{ name: 'Antes', value: `**${actual}s** de espera`, inline: true }] : [],
          footer: segundos === 0 ? undefined : 'para desactivarlo: /slowmode segundos:0',
        }),
      ],
    });
  },
};
