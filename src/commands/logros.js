const { SlashCommandBuilder } = require('discord.js');
const { datosDe, posicion, totalUsuarios, LOGROS } = require('../niveles');
const { brandEmbed, miles } = require('../utils/replies');

// Barra ASCII de 10 celdas para el progreso de cada logro (estilo /estadisticas).
function barraLogro(progreso) {
  const llenos = Math.round(Math.min(Math.max(progreso, 0), 1) * 10);
  return `${'█'.repeat(llenos)}${'░'.repeat(10 - llenos)}`;
}

// Unidades por campo, para el "faltan X mensajes más".
const UNIDADES = { mensajes: 'mensaje(s)', racha: 'día(s)', xp: 'XP', nivel: 'nivel(es)', findes: 'mensaje(s) de finde' };

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

    // Estadísticas crudas para calcular el progreso (0 en lo que no existe aún).
    const stats = { xp: datos.xp || 0, mensajes: datos.mensajes || 0, findes: datos.findes || 0, nivel: datos.nivel || 0, racha: datos.racha || 0 };

    const desbloqueados = LOGROS.filter((l) => obtenidos.includes(l.id));
    const pendientes = LOGROS.filter((l) => !obtenidos.includes(l.id));
    const xpCobrado = desbloqueados.reduce((s, l) => s + (l.premio || 0), 0);
    const xpPendiente = pendientes.reduce((s, l) => s + (l.premio || 0), 0);

    // Logros con meta: línea con barra y cuánto falta (ordenados por cercanía a cumplir).
    const conMeta = pendientes
      .filter((l) => l.meta)
      .map((l) => {
        const actual = stats[l.meta.campo] || 0;
        const objetivo = l.meta.objetivo;
        return { logro: l, actual, objetivo, progreso: actual / objetivo };
      })
      .sort((a, b) => b.progreso - a.progreso);

    const lineaPendiente = ({ logro, actual, objetivo, progreso }) => {
      const faltan = Math.max(objetivo - actual, 0);
      const unidad = UNIDADES[logro.meta.campo] ?? 'puntos';
      return `${logro.emoji} **${logro.nombre}** — ${miles(logro.premio)} XP\n\`${barraLogro(progreso)}\` faltan **${miles(faltan)} ${unidad}**`;
    };

    // Los de una sola vez (madrugador, búho) van al final, sin barra.
    const sinMeta = pendientes.filter((l) => !l.meta).map((l) => `${l.emoji} **${l.nombre}** — ${miles(l.premio)} XP · *se desbloquea al cumplirlo*`);

    // Próximo más cercano: primero de la lista de progreso.
    const proximo = conMeta[0];

    // Si ya los tiene todos, no tiene sentido mostrar secciones de progreso vacías.
    const quedanPendientes = pendientes.length > 0;

    const embed = brandEmbed({
      color: desbloqueados.length >= LOGROS.length ? 0xf1c40f : 0x5865f2,
      title: `Logros de ${user.username}`,
      thumbnail: user.displayAvatarURL({ size: 256 }),
      description:
        `🏅 **${desbloqueados.length}/${LOGROS.length}** desbloqueados · **${miles(xpCobrado)} XP** cobrados\n` +
        (proximo
          ? `Próximo más cercano: ${proximo.logro.emoji} **${proximo.logro.nombre}** — te faltan **${miles(Math.max(proximo.objetivo - proximo.actual, 0))} ${UNIDADES[proximo.logro.meta.campo] ?? 'puntos'}**`
          : '¡Los tenés todos! 👑'),
      fields: [
        ...(desbloqueados.length
          ? [{ name: `✅ Desbloqueados (${desbloqueados.length})`, value: desbloqueados.map((l) => `${l.emoji} **${l.nombre}** · +${miles(l.premio)} XP`).join('\n'), inline: false }]
          : []),
        ...(quedanPendientes && conMeta.length
          ? [
              { name: `🎯 En progreso (${conMeta.length})`, value: conMeta.map(lineaPendiente).join('\n\n'), inline: false },
              { name: '⏳ Sin progreso medible', value: sinMeta.join('\n') || '*—*', inline: false },
            ]
          : quedanPendientes
            ? [{ name: '🎯 En progreso', value: sinMeta.join('\n') || '*—*', inline: false }]
            : []),
      ],
      footer: `TriggerBOT • quedan ${miles(xpPendiente)} XP por cobrar • puesto #${posicion(guildId, user.id) || '—'} de ${miles(totalUsuarios(guildId))} en el ranking`,
    });

    return interaction.editReply({ embeds: [embed] });
  },
};
