const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { quiereSilencioso, diferir, intentar } = require('../utils/acciones');
const { pedir } = require('../utils/confirmaciones');

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
    const guild = interaction.guild;
    const bloquear = accion === 'bloquear';

    if (!channel.manageable) {
      return interaction.reply({
        embeds: [errorEmbed(`No tengo permiso para gestionar <#${channel.id}>. Revisá mis permisos en ese canal.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Aplica el cambio de permiso y devuelve el resultado real + el embed.
    const aplicar = async (autor, hacerBloqueo) => {
      const resultado = await intentar(hacerBloqueo ? 'Discord rechazó el bloqueo' : 'Discord rechazó el desbloqueo', () =>
        channel.permissionOverwrites.edit(
          guild.roles.everyone,
          { SendMessages: hacerBloqueo ? false : null },
          reason ? `${reason} — por ${autor.user.tag}` : `por ${autor.user.tag}`
        )
      );

      const etiqueta = hacerBloqueo ? 'Bloqueo de canal (lockdown)' : 'Desbloqueo de canal';
      const caso = logAction(guild, {
        action: resultado.ok ? etiqueta : `${etiqueta} — rechazado`,
        color: resultado.ok ? (hacerBloqueo ? COLORS.error : COLORS.success) : COLORS.warn,
        target: { raw: `Canal ${channel} (\`#${channel.name}\`)` },
        moderator: autor.user,
        reason,
        extra: `Canal: <#${channel.id}>${resultado.ok ? '' : ` — ${resultado.error}`}`,
      });

      if (!resultado.ok) {
        return {
          ok: false,
          embeds: [
            errorEmbed(`No pude ${hacerBloqueo ? 'bloquear' : 'desbloquear'} <#${channel.id}>.\n> ${resultado.error}`, 'La acción no se aplicó'),
          ],
        };
      }

      return {
        ok: true,
        embeds: [
          accionEmbed({
            color: hacerBloqueo ? COLORS.error : COLORS.success,
            titulo: hacerBloqueo ? '🔒 Canal bloqueado' : '🔓 Canal desbloqueado',
            detalle: hacerBloqueo
              ? `**${channel}** quedó bloqueado: nadie de @everyone puede escribir hasta que lo desbloqueen.`
              : `**${channel}** fue desbloqueado: ya se puede volver a escribir.`,
            motivo: reason,
            caso,
            moderador: autor.member?.displayName ?? autor.user.username,
            footer: hacerBloqueo ? 'usá Deshacer o /lockdown accion:desbloquear' : undefined,
          }),
        ],
      };
    };

    // Desbloquear no es destructivo: se aplica directo, como antes.
    if (!bloquear) {
      await diferir(interaction, silencioso);
      const salida = await aplicar(interaction, false);
      return interaction.editReply({ embeds: salida.embeds });
    }

    // Cerrar un canal afecta a todos: se confirma antes de tocarlo.
    return pedir(interaction, {
      titulo: '🔒 Confirmar bloqueo de canal',
      color: COLORS.error,
      silencioso,
      deshacerLabel: 'Deshacer (desbloquear)',
      detalle: `Vas a cerrar **${channel}**: nadie de @everyone podrá escribir hasta que se desbloquee.\n**Motivo:** ${reason || '*no especificado*'}`,
      ejecutar: (btn) => aplicar(btn, true),
      deshacer: (btn) => aplicar(btn, false),
    });
  },
};
