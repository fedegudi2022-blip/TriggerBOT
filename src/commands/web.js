// /web — link oficial de la página TriGGer.Arena con botón directo.
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { brandEmbed } = require('../utils/replies');
const { WEB, DUENO_MENCION } = require('../comunidad');

module.exports = {
  data: new SlashCommandBuilder().setName('web').setDescription('Página web oficial de TriGGer.Arena'),

  async execute(interaction) {
    const embed = brandEmbed({
      color: 0x57f287,
      title: '🌐 TriGGer.Arena — Sitio oficial',
      description:
        `Entrá a **${WEB}** para novedades, torneos y todo lo de la comunidad.\n\n` +
        `Si buscás las redes sociales (WhatsApp, Steam, Instagram), usá \`/redes\`.\n` +
        `¿Preguntas? Hablá con el dueño ${DUENO_MENCION} o abrí un ticket de soporte.`,
    });

    const fila = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Visitar triggerarena.pro').setEmoji('🌐').setURL(WEB).setStyle(ButtonStyle.Link)
    );

    return interaction.reply({ embeds: [embed], components: [fila] });
  },
};
