// /ticket — publica el panel de soporte y configura dónde viven los tickets.
// Subcomandos:
//   publicar  (staff)  → manda el panel con el botón "Abrir ticket" al canal actual
//   categoria (staff)  → categoría donde se crean los canales de ticket
//   logs      (staff)  → canal donde quedan los transcripts al cerrar
//   mensaje   (staff)  → texto del panel (el embed de bienvenida del canal de soporte)
//   inactividad (staff) → horas sin movimiento antes de cerrar solo (0 = apagado)
//   stats     (staff)  → calificaciones, promedios por staff y motivos de cierre
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { successEmbed, errorEmbed, brandEmbed, COLORS, miles, barra } = require('../utils/replies');
const { panel, estadisticasTickets, HORAS_INACTIVIDAD_POR_DEFECTO, MOTIVOS_CIERRE, AVISO_INACTIVIDAD_MS } = require('../utils/tickets');
const { setGuildConfig } = require('../store');
const { exigirStaff } = require('../utils/permisos');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Sistema de tickets de soporte')
    .addSubcommand((s) => s.setName('publicar').setDescription('Publicar el panel de soporte en este canal'))
    .addSubcommand((s) =>
      s
        .setName('categoria')
        .setDescription('Categoría donde se crean los canales de ticket')
        .addChannelOption((o) => o.setName('canal').setDescription('Categoría destino').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('logs')
        .setDescription('Canal donde se guardan los transcripts al cerrar un ticket')
        .addChannelOption((o) => o.setName('canal').setDescription('Canal de logs').addChannelTypes(ChannelType.GuildText).setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('mensaje')
        .setDescription('Texto del panel de soporte (lo que ven los usuarios antes de abrir)')
        .addStringOption((o) => o.setName('texto').setDescription('Nuevo texto del panel').setMaxLength(1000).setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('inactividad')
        .setDescription(`Cerrar solo los tickets sin actividad (por defecto ${HORAS_INACTIVIDAD_POR_DEFECTO} h; 0 = apagado)`)
        .addIntegerOption((o) =>
          o
            .setName('horas')
            .setDescription('Horas sin movimiento antes de cerrar (0 desactiva el auto-cierre)')
            .setMinValue(0)
            .setMaxValue(720)
            .setRequired(true)
        )
    )
    .addSubcommand((s) => s.setName('stats').setDescription('Calificaciones, promedios por staff y motivos de cierre')),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ManageGuild))) return;

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'publicar') {
      // Diferido antes del envío: publicar el panel implica una llamada a la API y
      // sin esto la interacción puede expirar.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const enviado = await interaction.channel.send(panel(guild)).catch((e) => e);
      if (enviado instanceof Error) {
        return interaction.editReply({
          embeds: [errorEmbed(`No pude publicar el panel en este canal.\n> ${enviado.message}`)],
        });
      }
      return interaction.editReply({ embeds: [successEmbed('Los usuarios ya pueden abrir tickets desde el botón del panel.')] });
    }

    if (sub === 'categoria') {
      const cat = interaction.options.getChannel('canal', true);
      setGuildConfig(guild.id, (c) => {
        c.tickets = c.tickets || {};
        c.tickets.categoriaId = cat.id;
      });
      return interaction.reply({ embeds: [successEmbed(`Los tickets se crearán en la categoría **${cat.name}**.`)] });
    }

    if (sub === 'logs') {
      const canal = interaction.options.getChannel('canal', true);
      setGuildConfig(guild.id, (c) => {
        c.tickets = c.tickets || {};
        c.tickets.canalLogs = canal.id;
      });
      return interaction.reply({ embeds: [successEmbed(`Los transcripts de tickets llegarán a ${canal}.`)] });
    }

    if (sub === 'mensaje') {
      const texto = interaction.options.getString('texto', true);
      setGuildConfig(guild.id, (c) => {
        c.tickets = c.tickets || {};
        c.tickets.mensajes = texto;
      });
      return interaction.reply({ embeds: [successEmbed('Texto actualizado. Volvé a publicar el panel con `/ticket publicar` para verlo en el canal.')] });
    }

    if (sub === 'inactividad') {
      const horas = interaction.options.getInteger('horas', true);
      // Se guarda 0 tal cual (no se borra la clave): la diferencia entre «sin
      // configurar» (72 h por defecto) y «apagado» (0) tiene que sobrevivir al panel
      // y a /ticket stats, que muestran valores distintos en cada caso.
      setGuildConfig(guild.id, (c) => {
        c.tickets = c.tickets || {};
        c.tickets.horasInactividad = horas;
      });
      const detalle =
        horas === 0
          ? `El auto-cierre por inactividad quedó **apagado** (se vuelve a activar con \`/ticket inactividad horas:${HORAS_INACTIVIDAD_POR_DEFECTO}\`).`
          : `Los tickets sin actividad se cierran solos a las **${horas} h**. El aviso previo llega **1 h antes** y cualquier mensaje en el canal reinicia el reloj.`;
      return interaction.reply({ embeds: [successEmbed(detalle)] });
    }

    if (sub === 'stats') {
      const stats = estadisticasTickets(guild.id);
      const nombreMotivo = Object.fromEntries([
        ...MOTIVOS_CIERRE.map((m) => [m.valor, m.etiqueta]),
        ['inactividad', 'Inactividad'],
      ]);

      const maximo = Math.max(1, ...stats.distribucion.map((d) => d.cantidad));
      const distribucion = stats.distribucion
        .slice()
        .reverse()
        .map((d) => `${d.valor}★ ${barra(d.cantidad, maximo, 10)} ${d.cantidad}`)
        .join('\n');

      const porStaff = stats.staff.length
        ? stats.staff
            .slice(0, 8)
            .map((s) => `<@${s.staffId}> — **${s.promedio.toFixed(1)}/5** (${miles(s.total)} encuesta${s.total === 1 ? '' : 's'})`)
            .join('\n')
        : '*Todavía no hay tickets reclamados y calificados.*';

      const motivos = stats.motivos.length
        ? stats.motivos.map((m) => `• **${nombreMotivo[m.clave] ?? m.clave}**: ${miles(m.cantidad)}`).join('\n')
        : '*Todavía no hay cierres registrados.*';

      const ultimas = stats.ultimas.length
        ? stats.ultimas
            .map((c) => `#${c.numero} · **${c.valor}/5** · ${c.staffId ? `<@${c.staffId}>` : 'sin reclamo'} · <t:${Math.floor(c.ts / 1000)}:d>`)
            .join('\n')
        : '*Sin calificaciones todavía.*';

      const resumen =
        stats.total === 0
          ? 'Todavía no hay encuestas respondidas.'
          : `**Promedio general:** ${stats.promedio.toFixed(2)}/5 sobre **${miles(stats.total)}** encuesta(s).`;

      return interaction.reply({
        embeds: [
          brandEmbed({
            color: stats.promedio !== null && stats.promedio < 3 ? COLORS.warn : COLORS.info,
            title: 'Estadísticas de tickets',
            description: `${resumen}\n\n**Distribución**\n${distribucion}`,
            fields: [
              { name: 'Calificación por staff', value: porStaff, inline: false },
              { name: 'Motivos de cierre', value: `${motivos}\n\n**Cierres registrados:** ${miles(stats.cierres)}`, inline: false },
              { name: 'Últimas calificaciones', value: ultimas, inline: false },
              {
                name: 'Auto-cierre por inactividad',
                value:
                  stats.horasInactividad > 0
                    ? `**${stats.horasInactividad} h** sin actividad (aviso ${Math.round(AVISO_INACTIVIDAD_MS / 3_600_000)} h antes) · \`/ticket inactividad\``
                    : 'Apagado · `/ticket inactividad horas:72` para activarlo',
                inline: false,
              },
            ],
            footer: 'TriggerBOT • /ticket stats',
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
