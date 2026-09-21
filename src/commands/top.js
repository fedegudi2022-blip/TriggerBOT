const { SlashCommandBuilder } = require('discord.js');
const { ranking } = require('../niveles');
const { brandEmbed } = require('../utils/replies');

const MEDALLAS = ['🥇', '🥈', '🥉'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('top')
    .setDescription('Ranking de actividad del servidor')
    .addIntegerOption((o) => o.setName('pagina').setDescription('Página del ranking (10 por página)').setMinValue(1).setMaxValue(10)),

  async execute(interaction) {
    const pagina = interaction.options.getInteger('pagina') ?? 1;
    const desde = (pagina - 1) * 10;
    const lista = ranking(interaction.guild.id, desde + 10).slice(desde);

    if (!lista.length) {
      return interaction.reply({ content: 'Todavía no hay datos de actividad en este rango.', ephemeral: true });
    }

    const lineas = lista.map((e, i) => {
      const posicionGlobal = desde + i + 1;
      const medalla = MEDALLAS[posicionGlobal - 1] ?? `\`#${posicionGlobal}\``;
      return `${medalla} <@${e.userId}> — **nivel ${e.nivel}** · ${e.xp} XP · ${e.mensajes} mensajes`;
    });

    const embed = brandEmbed({
      color: 0xfee75c,
      title: `Ranking de actividad (página ${pagina})`,
      description: lineas.join('\n'),
      footer: 'TriggerBOT • /estadisticas para ver tu perfil completo',
    });

    return interaction.reply({ embeds: [embed] });
  },
};
