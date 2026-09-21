const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { datosDe, xpParaNivel, posicion, LOGROS } = require('../niveles');
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
    .setDescription('Muestra tu ficha de niveles: XP, nivel, racha y logros')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar (vacío = vos)')),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario') ?? interaction.user;
    const datos = datosDe(interaction.guild.id, user.id);
    const puesto = posicion(interaction.guild.id, user.id);

    const logrosObtenidos = datos.logros ?? [];
    const lineasLogros = LOGROS.map((l) => {
      const conseguido = logrosObtenidos.includes(l.id);
      return `${conseguido ? l.emoji : '▢'} **${l.nombre}** — ${conseguido ? 'conseguido' : l.desc}`;
    }).join('\n');

    const embed = brandEmbed({
      color: 0xe67e22,
      title: `Perfil de niveles — ${user.username}`,
      thumbnail: user.displayAvatarURL({ size: 128 }),
      description: `**Nivel ${datos.nivel}** · Puesto **#${puesto || '—'}** del server`,
      fields: [
        { name: 'XP total', value: `**${datos.xp}** / ${xpParaNivel(datos.nivel + 1)} para el nivel ${datos.nivel + 1}`, inline: true },
        { name: 'Mensajes', value: `**${datos.mensajes}**`, inline: true },
        { name: 'Racha', value: `**${datos.racha || 0}** día(s) seguidos`, inline: true },
        { name: 'Progreso al siguiente nivel', value: `\`${barra(datos.xp, datos.nivel)}\``, inline: false },
        { name: `Logros (${logrosObtenidos.length}/${LOGROS.length})`, value: lineasLogros.slice(0, 1024), inline: false },
      ],
      footer: 'TriggerBOT • ganás XP escribiendo (máximo 1 mensaje por minuto cuenta)',
    });

    return interaction.reply({ embeds: [embed] });
  },
};
