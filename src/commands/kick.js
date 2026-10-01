const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');
const { quiereSilencioso, resolverMiembro, intentar } = require('../utils/acciones');
const { pedir } = require('../utils/confirmaciones');
const { exigirStaff } = require('../utils/permisos');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulsa a un usuario del servidor')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a expulsar').setRequired(true))
    .addStringOption((o) =>
      o.setName('razon').setDescription('Motivo de la expulsión (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true)
    )
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async autocomplete(interaction) {
    return autocompletar(interaction);
  },

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.KickMembers))) return;

    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);
    const guild = interaction.guild;

    const member = await resolverMiembro(interaction);

    // Validaciones antes de mostrar el panel: el error sale al instante y como efímero.
    const error =
      motivoNoModerable(interaction, member) ??
      (member?.kickable ? null : 'No puedo expulsarlo: su rol está por encima del mío (o es el dueño del servidor).');
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    // Un kick es irreversible desde el lado del usuario: se confirma antes de tocar la API.
    return pedir(interaction, {
      titulo: 'Confirmar expulsión',
      color: COLORS.error,
      silencioso,
      detalle: `Vas a expulsar a **${user.tag}** (${user}).\n**Motivo:** ${reason || '*no especificado*'}`,
      ejecutar: async (btn) => {
        const resultado = await intentar('Discord rechazó la expulsión', () =>
          member.kick(reason ? `${reason} — por ${btn.user.tag}` : `por ${btn.user.tag}`)
        );

        const caso = logAction(guild, {
          action: resultado.ok ? 'Expulsión (kick)' : 'Expulsión (kick) — rechazada',
          color: resultado.ok ? COLORS.error : COLORS.warn,
          target: user,
          moderator: btn.user,
          reason,
          extra: resultado.ok ? undefined : resultado.error,
        });

        if (!resultado.ok) {
          return { ok: false, embeds: [errorEmbed(`No se pudo expulsar a ${user}.\n> ${resultado.error}`, 'La acción no se aplicó')] };
        }

        // El DM va DESPUÉS de la acción: avisar antes deja al usuario con una
        // notificación de algo que puede haber fallado. Sin await: es una cortesía y
        // no debe demorar la confirmación.
        void avisarPorDM(user, `Fuiste expulsado de **${guild.name}**.\n**Motivo:** ${reason || 'no especificado'}`);

        return {
          ok: true,
          embeds: [
            accionEmbed({
              titulo: 'Expulsión',
              detalle: `${user} fue expulsado del servidor.`,
              motivo: reason,
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
