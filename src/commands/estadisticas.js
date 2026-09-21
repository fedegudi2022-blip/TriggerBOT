const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { datosDe, xpParaNivel, posicion, rangoDe, multiplicador, LOGROS } = require('../niveles');
const { brandEmbed } = require('../utils/replies');

// Barra de progreso ASCII entre el nivel actual y el siguiente.
function barra(xp, nivel) {
  const actual = xpParaNivel(nivel);
  const siguiente = xpParaNivel(nivel + 1);
  const progreso = Math.min(Math.max((xp - actual) / (siguiente - actual), 0), 1);
  const llenos = Math.round(progreso * 14);
  return `${'█'.repeat(llenos)}${'░'.repeat(14 - llenos)} ${Math.round(progreso * 100)}%`;
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

    // XP ganado por logros ya cobrados.
    const ganadoLogros = LOGROS.filter((l) => logrosObtenidos.includes(l.id)).reduce((s, l) => s + (l.premio || 0), 0);

    const lineasLogros = LOGROS.map((l) => {
      const conseguido = logrosObtenidos.includes(l.id);
      return `${conseguido ? l.emoji : '▢'} **${l.nombre}** · ${l.premio} XP — ${conseguido ? 'obtenido' : l.desc}`;
    }).join('\n');

    const embed = brandEmbed({
      color: rango.color,
      title: `Perfil de niveles — ${user.username}`,
      thumbnail: user.displayAvatarURL({ size: 256 }),
      description: `**${rango.nombre}** · Nivel **${datos.nivel}** · Puesto **#${puesto || '—'}** del server`,
      fields: [
        { name: 'XP', value: `**${datos.xp}** / ${xpParaNivel(datos.nivel + 1)} (nivel ${datos.nivel + 1})`, inline: true },
        { name: 'Mensajes', value: `**${datos.mensajes}**`, inline: true },
        { name: 'Racha', value: `**${datos.racha || 0}** día(s)`, inline: true },
        { name: 'Progreso al siguiente nivel', value: `\`${barra(datos.xp, datos.nivel)}\``, inline: false },
        {
          name: 'Bonus activos',
          value: bono.partes.length ? bono.partes.join(' · ') + ` → total **x${bono.total.toFixed(2)}**` : 'Ninguno ahora (activá racha con actividad diaria)',
          inline: false,
        },
        {
          name: `Logros (${logrosObtenidos.length}/${LOGROS.length}) · ${ganadoLogros} XP ganado`,
          value: lineasLogros.slice(0, 1024),
          inline: false,
        },
      ],
      footer: 'TriggerBOT • ganás XP escribiendo (máx. 1 mensaje por minuto) • findes: x2',
    });

    return interaction.editReply({ embeds: [embed] });
  },
};
