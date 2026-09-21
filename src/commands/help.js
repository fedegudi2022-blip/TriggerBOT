const { SlashCommandBuilder } = require('discord.js');
const { construirGuia } = require('../utils/guia');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Muestra la guía completa de TriggerBOT y todos sus comandos'),

  async execute(interaction, client) {
    return interaction.reply({ embeds: [construirGuia(client)] });
  },
};
