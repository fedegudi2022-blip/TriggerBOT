const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');
const { quiereSilencioso, diferir, resolverMiembro, intentar } = require('../utils/acciones');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulsa a un usuario del servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a expulsar').setRequired(true))
    .addStringOption((o) =>
      o.setName('razon').setDescription('Motivo de la expulsión (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true)
    )
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async autocomplete(interaction) {
    return autocompletar(interaction);
  },

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);

    const member = await resolverMiembro(interaction);

    // Validaciones antes de diferir: el error sale al instante y como efímero.
    const error =
      motivoNoModerable(interaction, member) ??
      (member?.kickable ? null : 'No puedo expulsarlo: su rol está por encima del mío (o es el dueño del servidor).');
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    // Diferimos ANTES de tocar la API de Discord: la ventana de 3 segundos no
    // depende de cuánto tarde la expulsión.
    await diferir(interaction, silencioso);

    const resultado = await intentar('Discord rechazó la expulsión', () =>
      member.kick(reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`)
    );

    const caso = logAction(interaction.guild, {
      action: resultado.ok ? 'Expulsión (kick)' : 'Expulsión (kick) — rechazada',
      color: resultado.ok ? COLORS.error : COLORS.warn,
      target: user,
      moderator: interaction.user,
      reason,
      extra: resultado.ok ? undefined : resultado.error,
    });

    if (!resultado.ok) {
      return interaction.editReply({
        embeds: [errorEmbed(`No se pudo expulsar a ${user}.\n> ${resultado.error}`, 'La acción no se aplicó')],
      });
    }

    // El DM va DESPUÉS de la acción: avisar antes deja al usuario con una
    // notificación de algo que puede haber fallado. Sin await: es una cortesía y
    // no debe demorar la confirmación.
    void avisarPorDM(user, `👢 Fuiste expulsado de **${interaction.guild.name}**.\n**Motivo:** ${reason || 'no especificado'}`);

    return interaction.editReply({
      embeds: [
        accionEmbed({
          titulo: '👢 Expulsión',
          detalle: `${user} fue expulsado del servidor.`,
          motivo: reason,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          thumbnail: user.displayAvatarURL({ size: 128 }),
        }),
      ],
    });
  },
};
