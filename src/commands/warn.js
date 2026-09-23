const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { addWarn } = require('../warns');
const { getGuildConfig } = require('../store');
const { logAction } = require('../utils/modlog');
const { logEvent } = require('../utils/log');
const { errorEmbed, accionEmbed, marcaTiempo, textoDuracion, COLORS } = require('../utils/replies');
const { ACCIONES, resolver, corresponde, duracionMs, aplicar } = require('../utils/escalada');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');
const { quiereSilencioso, diferir, resolverMiembro } = require('../utils/acciones');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Advierte a un usuario (la escalada automática se configura en /config)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a advertir').setRequired(true))
    .addStringOption((o) =>
      o.setName('razon').setDescription('Motivo de la advertencia (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true)
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

    const error = motivoNoModerable(interaction, member);
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    await diferir(interaction, silencioso);

    // La advertencia se guarda SIEMPRE: es historial, no una acción de Discord.
    const total = addWarn(interaction.guild.id, user.id, {
      reason: reason || 'No especificado',
      moderatorId: interaction.user.id,
      timestamp: Date.now(),
    });

    // Escalada automática: umbral, duración y acción salen de config.escalada
    // (se ajustan desde /config). El resultado se reporta tal cual — antes se
    // respondía "quedó silenciado 1 hora" aunque Discord hubiera rechazado el timeout.
    const politica = resolver(getGuildConfig(interaction.guild.id));
    const escalada = corresponde(politica, total)
      ? await aplicar(member, politica, `Acumuló ${total} advertencias — por ${interaction.user.tag}`)
      : null;

    // Duración legible de la escalada: el rol Silenciado no vence solo.
    const duracionEscalada = politica.accion === 'mute' ? 'Indefinido' : textoDuracion(duracionMs(politica));
    const hasta = politica.accion === 'mute' ? null : marcaTiempo(Date.now() + duracionMs(politica));

    const restantes = Math.max(politica.umbral - total, 0);
    const caso = logAction(interaction.guild, {
      action: 'Advertencia (warn)',
      color: COLORS.warn,
      target: user,
      moderator: interaction.user,
      reason,
      extra:
        `Total acumulado: ${total} advertencia(s).` +
        (escalada ? (escalada.ok ? ` Escalada aplicada: ${ACCIONES[escalada.tipo]}.` : ` Escalada fallida: ${escalada.error}`) : ''),
    });

    // El caso de la escalada va aparte: la aplicó el bot, no el moderador que
    // puso el aviso, y la acción puede ser timeout, mute, expulsión o ban.
    if (escalada?.ok) {
      logAction(interaction.guild, {
        action: `Escalada automática (${total} warns) — ${ACCIONES[escalada.tipo]}`,
        target: user,
        moderator: interaction.client.user,
        reason: `Acumuló ${total} advertencias`,
        duration: escalada.tipo === 'mute' ? 'Indefinido' : duracionEscalada,
      });
    }

    logEvent(interaction.guild, {
      color: COLORS.warn,
      title: 'Advertencia',
      description: `${user} fue advertido por ${interaction.user}.`,
      fields: [
        { name: 'Motivo', value: reason || '*No especificado*' },
        { name: 'Acumulado', value: `${total} advertencia(s)`, inline: true },
      ],
    });

    // El DM refleja solo lo que realmente pasó: si la escalada fue expulsión o ban,
    // avisarPorDM falla en silencio (ya no está en el servidor) y no se menciona.
    void avisarPorDM(
      user,
      `⚠️ Recibiste una advertencia en **${interaction.guild.name}**.\n` +
        `**Motivo:** ${reason || 'no especificado'}\n` +
        `**Advertencias acumuladas:** ${total} de ${politica.umbral}` +
        (escalada?.ok && escalada.tipo === 'timeout' ? `\n🔇 Quedaste silenciado hasta ${hasta}.` : '') +
        (escalada?.ok && escalada.tipo === 'mute' ? '\n🔇 Quedaste silenciado con el rol Silenciado.' : '')
    );

    const campos = [];
    if (escalada) {
      const etiqueta = ACCIONES[escalada.tipo];
      campos.push({
        name: escalada.ok ? `✅ Escalada aplicada — ${etiqueta}` : '⚠️ La escalada no se aplicó',
        value: escalada.ok
          ? `Llegó a **${total}** advertencias: ${etiqueta.toLowerCase()}` +
            (escalada.tipo === 'mute' ? ' (el rol no vence solo: se quita con /unmute).' : escalada.tipo === 'timeout' ? ` hasta ${hasta}.` : '.')
          : `${escalada.error}\n\nRevisá mi rol y mis permisos, o cambiá la acción de la escalada en \`/config\`.`,
        inline: false,
      });
    } else {
      campos.push({
        name: 'Historial',
        value: politica.accion === 'ninguna'
          ? `${total} advertencia(s) acumulada(s). La escalada está configurada para no sancionar.`
          : `${total} advertencia(s) — le ${restantes === 1 ? 'queda' : 'quedan'} **${restantes}** para la escalada (${ACCIONES[politica.accion].toLowerCase()}).`,
        inline: false,
      });
    }

    return interaction.editReply({
      embeds: [
        accionEmbed({
          color: COLORS.warn,
          titulo: '⚠️ Advertencia',
          detalle: `${user} fue advertido.`,
          motivo: reason,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          thumbnail: user.displayAvatarURL({ size: 128 }),
          campos,
          footer: 'historial completo con /warnings · se quita con /quitarnota',
        }),
      ],
    });
  },
};
