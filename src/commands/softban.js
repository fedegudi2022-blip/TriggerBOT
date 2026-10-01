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
    .setName('softban')
    .setDescription('Banea y desbanea al instante: expulsa al usuario borrando todos sus mensajes')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a expulsar con limpieza de mensajes').setRequired(true))
    .addIntegerOption((o) => o.setName('borrar_dias').setDescription('Días de mensajes a borrar (0-7, por defecto 1)').setMinValue(0).setMaxValue(7))
    .addStringOption((o) =>
      o.setName('razon').setDescription('Motivo del softban (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true)
    )
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async autocomplete(interaction) {
    return autocompletar(interaction);
  },

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.BanMembers))) return;

    const user = interaction.options.getUser('usuario', true);
    const deleteDays = interaction.options.getInteger('borrar_dias') ?? 1;
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);
    const guild = interaction.guild;

    const member = await resolverMiembro(interaction);

    const error =
      motivoNoModerable(interaction, member) ??
      (member?.bannable ? null : 'No puedo expulsarlo: su rol está por encima del mío (o es el dueño del servidor).');
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    return pedir(interaction, {
      titulo: 'Confirmar softban',
      color: COLORS.naranja,
      silencioso,
      detalle:
        `**${user.tag}** (${user}) será expulsado y podrá volver a entrar, borrando sus mensajes de los últimos **${deleteDays}** día(s).\n` +
        `**Motivo:** ${reason || '*no especificado*'}`,
      ejecutar: async (btn) => {
        // Dos pasos, dos resultados: si el unban falla el usuario queda baneado, y eso
        // hay que decirlo (antes se respondía "puede volver cuando quiera" igual).
        const baneo = await intentar('Discord rechazó el baneo', () =>
          guild.members.ban(user.id, {
            deleteMessageSeconds: deleteDays * 86400,
            reason: `[softban] ${reason || 'no especificado'} — por ${btn.user.tag}`,
          })
        );
        const desbaneo = baneo.ok
          ? await intentar('Discord rechazó el desbaneo posterior', () =>
              guild.members.unban(user.id, `[softban] purga de mensajes — por ${btn.user.tag}`)
            )
          : { ok: false, error: 'no se intentó: el baneo no se aplicó' };

        const ok = baneo.ok && desbaneo.ok;
        const caso = logAction(guild, {
          action: ok ? 'Expulsión con limpieza (softban)' : 'Expulsión con limpieza (softban) — incompleta',
          color: ok ? COLORS.naranja : COLORS.warn,
          target: user,
          moderator: btn.user,
          reason,
          extra: [
            `Se borraron sus mensajes de los últimos ${deleteDays} día(s).`,
            ok ? null : `Baneo: ${baneo.ok ? 'ok' : baneo.error} · Desbaneo: ${desbaneo.ok ? 'ok' : desbaneo.error}`,
          ]
            .filter(Boolean)
            .join(' '),
        });

        if (!baneo.ok) {
          return { ok: false, embeds: [errorEmbed(`No se pudo expulsar a ${user}.\n> ${baneo.error}`, 'La acción no se aplicó')] };
        }

        void avisarPorDM(user, `Fuiste expulsado de **${guild.name}** con limpieza de mensajes.\n**Motivo:** ${reason || 'no especificado'}`);

        // El baneo sí se aplicó pero el desbaneo no: el usuario quedó baneado sin querer.
        if (!desbaneo.ok) {
          return {
            ok: false,
            embeds: [
              errorEmbed(
                `**${user.tag}** quedó baneado (no se pudo desbanear).\n> ${desbaneo.error}\n\nDesbanealo con \`/unban usuario_id:${user.id}\`.`,
                'Softban incompleto'
              ),
            ],
          };
        }

        return {
          ok: true,
          embeds: [
            accionEmbed({
              titulo: 'Softban',
              detalle: `${user} fue expulsado con limpieza de **${deleteDays} día(s)** de mensajes. Puede volver a entrar cuando quiera.`,
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
