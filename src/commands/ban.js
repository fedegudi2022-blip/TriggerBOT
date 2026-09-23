const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');
const { quiereSilencioso, diferir, resolverMiembro, intentar } = require('../utils/acciones');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Banea a un usuario del servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a banear').setRequired(true))
    .addStringOption((o) =>
      o.setName('razon').setDescription('Motivo del baneo (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true)
    )
    .addIntegerOption((o) => o.setName('borrar_dias').setDescription('Borrar mensajes de los últimos X días (0-7)').setMinValue(0).setMaxValue(7))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async autocomplete(interaction) {
    return autocompletar(interaction);
  },

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const deleteDays = interaction.options.getInteger('borrar_dias') ?? 0;
    const silencioso = quiereSilencioso(interaction);

    const member = await resolverMiembro(interaction);

    // El objetivo puede no estar en el servidor (ban a alguien que ya se fue): en
    // ese caso no hay jerarquía que validar, solo el permiso del bot.
    const error = member
      ? (motivoNoModerable(interaction, member) ??
        (member.bannable ? null : 'No puedo banearlo: su rol está por encima del mío (o es el dueño del servidor).'))
      : interaction.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)
        ? null
        : 'Me falta el permiso de **Banear miembros** para banear a alguien que no está en el servidor.';
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    await diferir(interaction, silencioso);

    const resultado = await intentar('Discord rechazó el baneo', () =>
      interaction.guild.members.ban(user.id, {
        deleteMessageSeconds: deleteDays * 86400,
        reason: reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`,
      })
    );

    const caso = logAction(interaction.guild, {
      action: resultado.ok ? 'Baneo (ban)' : 'Baneo (ban) — rechazado',
      color: resultado.ok ? COLORS.error : COLORS.warn,
      target: user,
      moderator: interaction.user,
      reason,
      extra: resultado.ok ? (deleteDays > 0 ? `Se borraron sus mensajes de los últimos ${deleteDays} día(s).` : undefined) : resultado.error,
    });

    if (!resultado.ok) {
      return interaction.editReply({
        embeds: [errorEmbed(`No se pudo banear a ${user}.\n> ${resultado.error}`, 'La acción no se aplicó')],
      });
    }

    void avisarPorDM(user, `⛔ Fuiste baneado de **${interaction.guild.name}**.\n**Motivo:** ${reason || 'no especificado'}`);

    return interaction.editReply({
      embeds: [
        accionEmbed({
          titulo: '🔨 Baneo',
          detalle: `${user} fue baneado del servidor.`,
          motivo: reason,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          thumbnail: user.displayAvatarURL({ size: 128 }),
          campos:
            deleteDays > 0 ? [{ name: 'Limpieza', value: `Se borraron sus mensajes de los últimos **${deleteDays}** día(s).`, inline: false }] : [],
          footer: 'usá /unban con su ID para revertirlo',
        }),
      ],
    });
  },
};
