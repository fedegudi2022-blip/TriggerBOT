const { SlashCommandBuilder } = require('discord.js');
const { datosDe, xpParaNivel, posicion, rangoDe, multiplicador, LOGROS } = require('../niveles');
const { brandEmbed, miles } = require('../utils/replies');

// Emoji por rango para la descripción.
const EMOJI_RANGO = { Leyenda: '👑', Veterano: '🛡️', Experto: '🌟', Activo: '⚡', Novato: '🌱' };

// Barra de progreso ASCII entre el nivel actual y el siguiente (20 celdas: más detalle).
function barra(xp, nivel) {
  const actual = xpParaNivel(nivel);
  const siguiente = xpParaNivel(nivel + 1);
  const progreso = Math.min(Math.max((xp - actual) / (siguiente - actual), 0), 1);
  const llenos = Math.round(progreso * 20);
  return `${'█'.repeat(llenos)}${'░'.repeat(20 - llenos)}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('estadisticas')
    .setDescription('Muestra tu ficha de niveles: XP, nivel, rango, racha y logros')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar (vacío = vos)')),

  async execute(interaction) {
    await interaction.deferReply();

    const user = interaction.options.getUser('usuario') ?? interaction.user;
    const guildId = interaction.guild.id;
    const datos = datosDe(guildId, user.id);
    const puesto = posicion(guildId, user.id);
    const rango = rangoDe(datos.nivel);
    const bono = multiplicador(datos.racha);
    const logrosObtenidos = datos.logros ?? [];

    const siguienteNivel = datos.nivel + 1;
    const xpSiguiente = xpParaNivel(siguienteNivel);
    const faltan = Math.max(xpSiguiente - datos.xp, 0);

    // XP ganado por logros ya cobrados.
    const ganadoLogros = LOGROS.filter((l) => logrosObtenidos.includes(l.id)).reduce((s, l) => s + (l.premio || 0), 0);

    // Logros en dos columnas compactas: ✅ conseguidos y 🔒 pendientes.
    const check = (l) => (logrosObtenidos.includes(l.id) ? `${l.emoji}` : '🔒');
    const linea = (l) => `${check(l)} **${l.nombre}** · ${miles(l.premio)} XP`;
    const mitad = Math.ceil(LOGROS.length / 2);
    const colA = LOGROS.slice(0, mitad).map(linea).join('\n');
    const colB = LOGROS.slice(mitad).map(linea).join('\n');

    const embed = brandEmbed({
      color: rango.color,
      title: `Perfil de niveles — ${user.username}`,
      thumbnail: user.displayAvatarURL({ size: 256 }),
      description:
        `${EMOJI_RANGO[rango.nombre] ?? '🎖️'} **${rango.nombre}** · Nivel **${datos.nivel}** · Puesto **#${puesto || '—'}** del server\n` +
        `Le faltan **${miles(faltan)} XP** para el nivel ${siguienteNivel}`,
      fields: [
        { name: '💎 XP total', value: `**${miles(datos.xp)}** / ${miles(xpSiguiente)}`, inline: true },
        { name: '💬 Mensajes', value: `**${miles(datos.mensajes)}**`, inline: true },
        { name: '🔥 Racha', value: `**${datos.racha || 0}** día(s)`, inline: true },
        { name: 'Progreso al siguiente nivel', value: `\`${barra(datos.xp, datos.nivel)}\` ${Math.round(((datos.xp - xpParaNivel(datos.nivel)) / (xpSiguiente - xpParaNivel(datos.nivel))) * 100)}%`, inline: false },
        {
          name: '✨ Bonus activos',
          value: bono.partes.length ? bono.partes.join(' · ') + ` → total **x${bono.total.toFixed(2)}**` : 'Ninguno ahora (activá racha con actividad diaria)',
          inline: false,
        },
        {
          name: `🏅 Logros — ${logrosObtenidos.length}/${LOGROS.length} · ${miles(ganadoLogros)} XP cobrado`,
          value: colA,
          inline: true,
        },
        { name: '\u200b', value: colB, inline: true },
      ],
      footer: 'TriggerBOT • ganás XP escribiendo (máx. 1 mensaje por minuto) • findes: x2',
    });

    return interaction.editReply({ embeds: [embed] });
  },
};
