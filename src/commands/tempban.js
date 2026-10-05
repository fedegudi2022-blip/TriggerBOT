const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');
const { quiereSilencioso, resolverMiembro, intentar } = require('../utils/acciones');
const { pedir } = require('../utils/confirmaciones');
const { exigirStaff } = require('../utils/permisos');
const { parsearDuracion, formatearDuracion, programar, cancelar } = require('../utils/tempbans');

// <t:...:f> = fecha completa, <t:...:R> = "en 3 horas". Discord las renderiza solo.
const marca = (ms, estilo = 'f') => `<t:${Math.floor(ms / 1000)}:${estilo}>`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tempban')
    .setDescription('Banea a un usuario por un tiempo y lo desbanea solo al vencer')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a banear temporalmente').setRequired(true))
    .addStringOption((o) =>
      o.setName('duracion').setDescription('Cuánto dura: 30m, 12h, 7d (sin unidad = minutos; de 1 min a 30 días)').setMaxLength(6)
    )
    .addStringOption((o) =>
      o.setName('razon').setDescription('Motivo del baneo (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true)
    )
    .addIntegerOption((o) => o.setName('borrar_dias').setDescription('Borrar mensajes de los últimos X días (0-7)').setMinValue(0).setMaxValue(7))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async autocomplete(interaction) {
    return autocompletar(interaction);
  },

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.BanMembers))) return;

    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const deleteDays = interaction.options.getInteger('borrar_dias') ?? 0;
    const silencioso = quiereSilencioso(interaction);
    const guild = interaction.guild;

    // La duración se valida ANTES de ofrecer la confirmación: mejor un error claro
    // que un modal de confirmación para algo que no se puede aplicar.
    const duracionTexto = interaction.options.getString('duracion') ?? '1d';
    const duracionMs = parsearDuracion(duracionTexto);
    if (!duracionMs) {
      return interaction.reply({
        embeds: [
          errorEmbed(`No pude interpretar la duración **${duracionTexto}**.\nUsá por ejemplo \`30m\`, \`12h\` o \`7d\` (de 1 minuto a 30 días).`),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
    const hasta = Date.now() + duracionMs;

    const member = await resolverMiembro(interaction);

    // Igual que /ban: si no está en el server no hay jerarquía que validar, solo el
    // permiso del bot. Si está, se respeta la jerarquía de roles.
    const error = member
      ? (motivoNoModerable(interaction, member) ??
        (member.bannable ? null : 'No puedo banearlo: su rol está por encima del mío (o es el dueño del servidor).'))
      : guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)
        ? null
        : 'Me falta el permiso de **Banear miembros** para banear a alguien que no está en el servidor.';
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    return pedir(interaction, {
      titulo: 'Confirmar baneo temporal',
      color: COLORS.warn,
      silencioso,
      deshacerLabel: 'Deshacer (desbanear)',
      detalle:
        `Vas a banear a **${user.username}** (${user}) durante **${formatearDuracion(duracionMs)}**.\n` +
        `Se desbanea solo el ${marca(hasta)} (${marca(hasta, 'R')}).\n` +
        (deleteDays > 0 ? `Se borrarán sus mensajes de los últimos **${deleteDays}** día(s).\n` : '') +
        `**Motivo:** ${reason || '*no especificado*'}`,
      ejecutar: async (btn) => {
        const resultado = await intentar('Discord rechazó el baneo', () =>
          guild.members.ban(user.id, {
            deleteMessageSeconds: deleteDays * 86400,
            reason: reason ? `${reason} — por ${btn.user.username}` : `por ${btn.user.username}`,
          })
        );

        const caso = logAction(guild, {
          action: resultado.ok ? 'Baneo temporal (tempban)' : 'Baneo temporal (tempban) — rechazado',
          color: resultado.ok ? COLORS.warn : COLORS.error,
          target: user,
          moderator: btn.user,
          reason,
          duration: formatearDuracion(duracionMs),
          extra: resultado.ok ? `Se desbanea solo el ${marca(hasta)}.` : resultado.error,
        });

        if (!resultado.ok) {
          return { ok: false, embeds: [errorEmbed(`No se pudo banear a ${user}.\n> ${resultado.error}`, 'La acción no se aplicó')] };
        }

        // El pendiente se guarda recién cuando el baneo salió bien: si Discord lo
        // rechazó no queda una entrada que después "desbanee" a nadie.
        programar(guild.id, { userId: user.id, hasta, razon: reason, moderadorId: btn.user.id, casoId: caso });

        void avisarPorDM(
          user,
          `Fuiste baneado temporalmente de **${guild.name}** durante ${formatearDuracion(duracionMs)}.\n` +
            `**Motivo:** ${reason || 'no especificado'}\nPodés volver el ${marca(hasta)} (${marca(hasta, 'R')}).`
        );

        return {
          ok: true,
          embeds: [
            accionEmbed({
              titulo: 'Baneo temporal',
              detalle: `${user} fue baneado por **${formatearDuracion(duracionMs)}**. El bot lo desbanea solo el ${marca(hasta)}.`,
              motivo: reason,
              caso,
              moderador: btn.member?.displayName ?? btn.user.username,
              thumbnail: user.displayAvatarURL({ size: 128 }),
              campos:
                deleteDays > 0
                  ? [{ name: 'Limpieza', value: `Se borraron sus mensajes de los últimos **${deleteDays}** día(s).`, inline: false }]
                  : [],
              footer: 'el desbaneo es automático; usá /unban si querés adelantarlo',
            }),
          ],
        };
      },
      deshacer: async (btn) => {
        const resultado = await intentar('Discord rechazó el desbaneo', () => guild.members.unban(user.id, `Deshecho por ${btn.user.username}`));
        // Se cancela el pendiente pase lo que pase: si el desbaneo salió, ya no hay
        // nada que hacer; si falló, que no quede una entrada fantasma.
        const teniaPendiente = cancelar(guild.id, user.id);
        const caso = logAction(guild, {
          action: resultado.ok ? 'Baneo temporal deshecho (deshacer)' : 'Baneo temporal deshecho (deshacer) — rechazado',
          color: resultado.ok ? COLORS.success : COLORS.warn,
          target: user,
          moderator: btn.user,
          reason: 'Reversión del baneo temporal',
          extra: resultado.ok ? 'Se canceló el desbaneo automático pendiente.' : resultado.error,
        });
        if (!resultado.ok) {
          return { embeds: [errorEmbed(`No se pudo deshacer el baneo.\n> ${resultado.error}`, 'La acción no se aplicó')] };
        }
        return {
          embeds: [
            accionEmbed({
              titulo: 'Baneo temporal deshecho',
              detalle: `**${user.username}** fue desbaneado.`,
              caso,
              moderador: btn.member?.displayName ?? btn.user.username,
              thumbnail: user.displayAvatarURL({ size: 128 }),
              footer: teniaPendiente ? 'también borré el desbaneo automático que estaba pendiente' : undefined,
            }),
          ],
        };
      },
    });
  },
};
