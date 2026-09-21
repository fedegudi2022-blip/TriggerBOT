const { SlashCommandBuilder } = require('discord.js');
const { brandEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Comprueba que el bot está vivo y su latencia'),
  async execute(interaction, client) {
    const sent = await interaction.reply({ content: '🏓 Calculando latencia...', fetchReply: true });
    await interaction.editReply({
      embeds: [
        brandEmbed({
          color: 0x57f287,
          title: '🏓 Pong!',
          description:
            `**Latencia del bot:** ${sent.createdTimestamp - interaction.createdTimestamp}ms\n` +
            `**Latencia de la API:** ${Math.round(client.ws.ping)}ms`,
        }),
      ],
      content: '',
    });
  },
};
