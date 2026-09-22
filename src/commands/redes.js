// /redes — todas las redes sociales oficiales de TriGGer.Arena en un embed,
// con botones de link directo (Discord los abre sin salir del cliente).
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { brandEmbed } = require('../utils/replies');
const { REDES, WEB } = require('../comunidad');

module.exports = {
  data: new SlashCommandBuilder().setName('redes').setDescription('Redes sociales y grupos oficiales de TriGGer.Arena'),

  async execute(interaction) {
    const lista = REDES.map((r) => `${r.emoji} **${r.nombre}** — ${r.desc}\n${r.url}`).join('\n\n');

    const embed = brandEmbed({
      color: 0x5865f2,
      title: '🌐 Redes oficiales de TriGGer.Arena',
      description: `Sumate a la comunidad en cualquiera de estos espacios:\n\n${lista}\n\n🌐 **Web:** ${WEB}`,
    });

    // Botones de link: hasta 5 por fila (tenemos 3 redes + la web).
    const fila = new ActionRowBuilder().addComponents(
      REDES.map((r) => new ButtonBuilder().setLabel(r.nombre).setEmoji(r.emoji).setURL(r.url).setStyle(ButtonStyle.Link)),
      new ButtonBuilder().setLabel('Sitio web').setEmoji('🌐').setURL(WEB).setStyle(ButtonStyle.Link)
    );

    return interaction.reply({ embeds: [embed], components: [fila] });
  },
};
