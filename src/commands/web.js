// /web — link oficial de la página TriGGer.Arena con botón directo.
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { brandEmbed, COLORS } = require('../utils/replies');
const { WEB } = require('../comunidad');

module.exports = {
  data: new SlashCommandBuilder().setName('web').setDescription('Página web oficial de TriGGer.Arena'),

  async execute(interaction) {
    const embed = brandEmbed({
      color: COLORS.success,
      title: '🌐 TriGGer.Arena — Sitio oficial',
      description:
        `Entrá a **${WEB}** para novedades, torneos y todo lo de la comunidad.\n\n` +
        `Si buscás las redes sociales (WhatsApp, Steam, Instagram), usá \`/redes\`.\n`,
    });

    const fila = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Visitar triggerarena.pro').setEmoji('🌐').setURL(WEB).setStyle(ButtonStyle.Link)
    );

    return interaction.reply({ embeds: [embed], components: [fila] });
  },
};
