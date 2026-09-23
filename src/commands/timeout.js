const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, marcaTiempo, textoDuracion, COLORS } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');
const { quiereSilencioso, diferir, resolverMiembro, intentar } = require('../utils/acciones');

const DURATIONS = {
  '5m': 5 * 60 * 1000,
  '10m': 10 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '28d': 28 * 24 * 60 * 60 * 1000,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Silencia a un usuario por un tiempo determinado')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a silenciar').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('duracion')
        .setDescription('Cuánto tiempo queda silenciado')
        .setRequired(true)
        .addChoices(
          { name: '🔊 Quitarlo ahora (levantar el silencio)', value: '0' },
          { name: '5 minutos', value: '5m' },
          { name: '10 minutos', value: '10m' },
          { name: '30 minutos', value: '30m' },
          { name: '1 hora', value: '1h' },
          { name: '6 horas', value: '6h' },
          { name: '1 día', value: '1d' },
          { name: '3 días', value: '3d' },
          { name: '7 días', value: '7d' },
          { name: '28 días (máximo de Discord)', value: '28d' }
        )
    )
    .addStringOption((o) =>
      o.setName('razon').setDescription('Motivo del silencio (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true)
    )
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async autocomplete(interaction) {
    return autocompletar(interaction);
  },

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const durationKey = interaction.options.getString('duracion', true);
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);
    // '0' = levantar un silencio activo (discord.js acepta null para quitarlo).
    const quitando = durationKey === '0';
    const ms = quitando ? null : (DURATIONS[durationKey] ?? DURATIONS['1h']);

    const member = await resolverMiembro(interaction);

    const error =
      motivoNoModerable(interaction, member) ??
      (member?.moderatable ? null : 'No puedo silenciarlo: su rol está por encima del mío (o es el dueño del servidor).');
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    await diferir(interaction, silencioso);

    const resultado = await intentar(quitando ? 'Discord rechazó levantar el silencio' : 'Discord rechazó el silencio', () =>
      member.timeout(ms, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`)
    );

    const etiqueta = quitando ? 'Silencio levantado (timeout)' : 'Silencio (timeout)';
    const caso = logAction(interaction.guild, {
      action: resultado.ok ? etiqueta : `${etiqueta} — rechazado`,
      color: resultado.ok ? (quitando ? COLORS.success : COLORS.error) : COLORS.warn,
      target: user,
      moderator: interaction.user,
      reason,
      duration: resultado.ok && !quitando ? textoDuracion(ms) : undefined,
      extra: resultado.ok ? undefined : resultado.error,
    });

    if (!resultado.ok) {
      return interaction.editReply({
        embeds: [
          errorEmbed(`No se pudo ${quitando ? `levantar el silencio de` : 'silenciar a'} ${user}.\n> ${resultado.error}`, 'La acción no se aplicó'),
        ],
      });
    }

    // Levantar el silencio es la mitad del comando: sin esto no había forma de
    // terminar un timeout antes de que venciera (el rol Silenciado es otra cosa).
    if (quitando) {
      void avisarPorDM(user, `🔊 Ya podés volver a hablar en **${interaction.guild.name}**.`);
      return interaction.editReply({
        embeds: [
          accionEmbed({
            titulo: '🔊 Silencio levantado',
            detalle: `${user} puede volver a hablar.`,
            motivo: reason,
            caso,
            moderador: interaction.member?.displayName ?? interaction.user.username,
            thumbnail: user.displayAvatarURL({ size: 128 }),
          }),
        ],
      });
    }

    // La marca de tiempo la renderiza Discord en la hora local de cada uno: el
    // staff y el sancionado ven exactamente cuándo termina, sin cuentas mentales.
    void avisarPorDM(
      user,
      `🔇 Fuiste silenciado en **${interaction.guild.name}** por ${textoDuracion(ms)} (hasta ${marcaTiempo(Date.now() + ms)}).\n**Motivo:** ${reason || 'no especificado'}`
    );

    return interaction.editReply({
      embeds: [
        accionEmbed({
          titulo: '🔇 Silencio',
          detalle: `${user} quedó silenciado por **${textoDuracion(ms)}**.`,
          motivo: reason,
          duracionTexto: `${textoDuracion(ms)} — termina ${marcaTiempo(Date.now() + ms)}`,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          thumbnail: user.displayAvatarURL({ size: 128 }),
          footer: 'para levantarlo antes, /timeout con la opción Quitarlo ahora',
        }),
      ],
    });
  },
};
