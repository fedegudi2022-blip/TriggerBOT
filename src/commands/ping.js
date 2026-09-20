const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Comprueba que el bot está vivo y su latencia'),
  async execute(interaction, client) {
    const sent = await interaction.reply({ content: '🏓 Pinging...', fetchReply: true });
    await interaction.editReply(
      `🏓 **Pong!**\n` +
        `Latencia del bot: **${sent.createdTimestamp - interaction.createdTimestamp}ms**\n` +
        `Latencia de la API: **${Math.round(client.ws.ping)}ms**`
    );
  },
};
