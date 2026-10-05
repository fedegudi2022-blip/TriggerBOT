const { SlashCommandBuilder } = require('discord.js');
const { datosDe, posicion, totalUsuarios, LOGROS, logrosConProgreso } = require('../niveles');
const { brandEmbed, miles, COLORS } = require('../utils/replies');

// Barra corta (10 celdas) que va al lado del nombre de cada logro pendiente.
function barraLogro(progreso) {
  const llenos = Math.round(Math.min(Math.max(progreso, 0), 1) * 10);
  return `${'█'.repeat(llenos)}${'░'.repeat(10 - llenos)}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('logros')
    .setDescription('Tu progreso en cada logro, con cuánto falta para desbloquearlos')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar (vacío = vos)')),

  async execute(interaction) {
    await interaction.deferReply();

    const user = interaction.options.getUser('usuario') ?? interaction.user;
    const guildId = interaction.guild.id;
    const datos = datosDe(guildId, user.id);
    const obtenidos = datos.logros ?? [];

    const desbloqueados = LOGROS.filter((l) => obtenidos.includes(l.id));
    const pendientes = LOGROS.filter((l) => !obtenidos.includes(l.id));
    const xpCobrado = desbloqueados.reduce((s, l) => s + (l.premio || 0), 0);
    const xpPendiente = pendientes.reduce((s, l) => s + (l.premio || 0), 0);

    // Progreso medible, del más cercano a cumplir al más lejano (lo calcula niveles.js,
    // así /estadisticas y /logros no pueden decir cosas distintas).
    const conMeta = logrosConProgreso(datos);
    // Los de una sola vez (madrugador, búho) no tienen progreso: van compactos en una línea.
    const sinMeta = pendientes.filter((l) => !l.meta);
    const proximo = conMeta[0];

    // Un logro por renglón, en una sola línea cada uno (antes iban separados por un
    // renglón vacío, así que 11 logros ocupaban 22 líneas de embed).
    const linea = ({ logro, faltan, unidad, progreso }) =>
      `\`${barraLogro(progreso)}\` **${logro.nombre}** — faltan ${miles(faltan)} ${unidad} · +${miles(logro.premio || 0)} XP`;

    const embed = brandEmbed({
      color: desbloqueados.length >= LOGROS.length ? COLORS.logro : COLORS.info,
      title: `Logros de ${user.username}`,
      thumbnail: user.displayAvatarURL({ size: 256 }),
      description:
        `**${desbloqueados.length}/${LOGROS.length}** desbloqueados · **${miles(xpCobrado)} XP** cobrados · **${miles(xpPendiente)} XP** por cobrar\n` +
        (proximo
          ? `Más cerca: **${proximo.logro.nombre}** — te faltan **${miles(proximo.faltan)} ${proximo.unidad}**`
          : '¡Los tenés todos!'),
      fields: [
        ...(conMeta.length ? [{ name: `En progreso (${conMeta.length})`, value: conMeta.map(linea).join('\n'), inline: false }] : []),
        ...(sinMeta.length
          ? [
              {
                name: `Sin progreso medible (${sinMeta.length})`,
                value: `${sinMeta.map((l) => `**${l.nombre}**`).join(' · ')} — se desbloquean cumpliéndolos`,
                inline: false,
              },
            ]
          : []),
        ...(desbloqueados.length
          ? [
              {
                name: `Desbloqueados (${desbloqueados.length})`,
                value: desbloqueados.map((l) => `**${l.nombre}** +${miles(l.premio || 0)}`).join(' · '),
                inline: false,
              },
            ]
          : []),
      ],
      footer: `TriggerBOT • puesto #${posicion(guildId, user.id) || '—'} de ${miles(totalUsuarios(guildId))} en el ranking`,
    });

    return interaction.editReply({ embeds: [embed] });
  },
};
