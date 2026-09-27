const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');
const { quiereSilencioso, resolverMiembro, intentar } = require('../utils/acciones');
const { pedir } = require('../utils/confirmaciones');

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
    const guild = interaction.guild;

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

    // Un baneo es irreversible desde el lado del usuario: se confirma antes de tocar la API.
    return pedir(interaction, {
      titulo: '🔨 Confirmar baneo',
      color: COLORS.error,
      silencioso,
      deshacerLabel: 'Deshacer (desbanear)',
      detalle:
        `Vas a banear a **${user.tag}** (${user}).\n` +
        (deleteDays > 0 ? `Se borrarán sus mensajes de los últimos **${deleteDays}** día(s).\n` : '') +
        `**Motivo:** ${reason || '*no especificado*'}`,
      ejecutar: async (btn) => {
        const resultado = await intentar('Discord rechazó el baneo', () =>
          guild.members.ban(user.id, {
            deleteMessageSeconds: deleteDays * 86400,
            reason: reason ? `${reason} — por ${btn.user.tag}` : `por ${btn.user.tag}`,
          })
        );

        const caso = logAction(guild, {
          action: resultado.ok ? 'Baneo (ban)' : 'Baneo (ban) — rechazado',
          color: resultado.ok ? COLORS.error : COLORS.warn,
          target: user,
          moderator: btn.user,
          reason,
          extra: resultado.ok ? (deleteDays > 0 ? `Se borraron sus mensajes de los últimos ${deleteDays} día(s).` : undefined) : resultado.error,
        });

        if (!resultado.ok) {
          return { ok: false, embeds: [errorEmbed(`No se pudo banear a ${user}.\n> ${resultado.error}`, 'La acción no se aplicó')] };
        }

        void avisarPorDM(user, `⛔ Fuiste baneado de **${guild.name}**.\n**Motivo:** ${reason || 'no especificado'}`);

        return {
          ok: true,
          embeds: [
            accionEmbed({
              titulo: '🔨 Baneo',
              detalle: `${user} fue baneado del servidor.`,
              motivo: reason,
              caso,
              moderador: btn.member?.displayName ?? btn.user.username,
              thumbnail: user.displayAvatarURL({ size: 128 }),
              campos:
                deleteDays > 0
                  ? [{ name: 'Limpieza', value: `Se borraron sus mensajes de los últimos **${deleteDays}** día(s).`, inline: false }]
                  : [],
              footer: 'usá el botón Deshacer o /unban con su ID',
            }),
          ],
        };
      },
      deshacer: async (btn) => {
        const resultado = await intentar('Discord rechazó el desbaneo', () => guild.members.unban(user.id, `Deshecho por ${btn.user.tag}`));
        const caso = logAction(guild, {
          action: resultado.ok ? 'Desbaneo (deshacer)' : 'Desbaneo (deshacer) — rechazado',
          color: resultado.ok ? COLORS.success : COLORS.warn,
          target: user,
          moderator: btn.user,
          reason: 'Reversión del baneo',
          extra: resultado.ok ? undefined : resultado.error,
        });
        if (!resultado.ok) {
          return { embeds: [errorEmbed(`No se pudo deshacer el baneo.\n> ${resultado.error}`, 'La acción no se aplicó')] };
        }
        return {
          embeds: [
            accionEmbed({
              titulo: '↩️ Baneo deshecho',
              detalle: `**${user.tag}** fue desbaneado.`,
              caso,
              moderador: btn.member?.displayName ?? btn.user.username,
              thumbnail: user.displayAvatarURL({ size: 128 }),
            }),
          ],
        };
      },
    });
  },
};
