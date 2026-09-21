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
      color: 0xfee75c,
      title: `Perfil de ${user.username}`,
      thumbnail: user.displayAvatarURL({ size: 128 }),
      fields: [
        { name: 'Nivel', value: `**${datos.nivel}**`, inline: true },
        { name: 'XP', value: `${datos.xp} (siguiente nivel: ${xpParaNivel(datos.nivel + 1)})`, inline: true },
        { name: 'Puesto en el server', value: puesto ? `#${puesto}` : '—', inline: true },
        { name: 'Progreso', value: `\`${barra(datos.xp, datos.nivel)}\``, inline: false },
        { name: 'Mensajes', value: String(datos.mensajes), inline: true },
        { name: 'Días seguidos activo', value: `${datos.racha || 0}`, inline: true },
        { name: `Logros (${logrosObtenidos.length}/${LOGROS.length})`, value: lineasLogros.slice(0, 1024), inline: false },
      ],
      footer: 'TriggerBOT • ganás XP escribiendo (máximo 1 mensaje por minuto cuenta)',
    });

    return interaction.reply({ embeds: [embed] });
  },
};
