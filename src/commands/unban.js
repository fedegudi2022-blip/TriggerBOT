const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { avisarPorDM } = require('../utils/moderation');
const { quiereSilencioso, diferir, intentar } = require('../utils/acciones');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Revoca el baneo de un usuario por su ID')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('usuario_id').setDescription('ID del usuario a desbanear (clic derecho → Copiar ID)').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del desbaneo').setMaxLength(500))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async execute(interaction) {
    const userId = interaction.options.getString('usuario_id', true).trim();
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);

    // Validación local primero: no se gasta una llamada a la API en una ID inválida.
    if (!/^\d{17,20}$/.test(userId)) {
      return interaction.reply({
        embeds: [
          errorEmbed(
            'Eso no parece una ID válida. Copiala con clic derecho sobre el usuario → **Copiar ID de usuario** (modo desarrollador activado).'
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    await diferir(interaction, silencioso);

    const bans = await interaction.guild.bans.fetch().catch(() => null);
    if (!bans) {
      return interaction.editReply({
        embeds: [errorEmbed('No pude leer la lista de baneos. Verificá que el bot tenga permiso de **Banear miembros**.')],
      });
    }

    const ban = bans.get(userId);
    if (!ban) {
      return interaction.editReply({ embeds: [errorEmbed('Ese usuario no está baneado en este servidor.')] });
    }

    const resultado = await intentar('Discord rechazó el desbaneo', () =>
      interaction.guild.members.unban(userId, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`)
    );

    const caso = logAction(interaction.guild, {
      action: resultado.ok ? 'Desbaneo (unban)' : 'Desbaneo (unban) — rechazado',
      color: resultado.ok ? COLORS.success : COLORS.warn,
      target: ban.user,
      moderator: interaction.user,
      reason,
      extra: resultado.ok ? undefined : resultado.error,
    });

    if (!resultado.ok) {
      return interaction.editReply({
        embeds: [errorEmbed(`No se pudo desbanear a **${ban.user.tag}**.\n> ${resultado.error}`, 'La acción no se aplicó')],
      });
    }

    void avisarPorDM(ban.user, `✅ Fuiste desbaneado de **${interaction.guild.name}**. Podés volver a entrar.`);

    return interaction.editReply({
      embeds: [
        accionEmbed({
          titulo: '✅ Desbaneo',
          detalle: `**${ban.user.tag}** fue desbaneado. Ya puede volver a entrar al servidor.`,
          motivo: reason,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          thumbnail: ban.user.displayAvatarURL({ size: 128 }),
          footer: 'si vuelve a entrar, el bot lo recibe como miembro nuevo',
        }),
      ],
    });
  },
};
