const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { estadoIA } = require('../utils/ia');
const { brandEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Muestra el estado del bot: IA, latencia y servicios'),

  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: true });

    const ia = await estadoIA();
    const iaTexto = ia.configurada
      ? `✅ Activada — modelo \`${ia.modelo}\``
      : '❌ Sin clave (respuestas locales)';

    const uptime = process.uptime();
    const dias = Math.floor(uptime / 86400);
    const horas = Math.floor((uptime % 86400) / 3600);
    const minutos = Math.floor((uptime % 3600) / 60);
    const uptimeTexto = dias > 0 ? `${dias}d ${horas}h ${minutos}m` : horas > 0 ? `${horas}h ${minutos}m` : `${minutos}m`;

    const embed = new EmbedBuilder()
      .setTitle('📊 Estado de TriggerBOT')
      .setColor(ia.configurada ? 0x57f287 : 0xfee75c)
      .addFields(
        { name: '🤖 Chat con IA', value: iaTexto, inline: false },
        { name: '📡 Latencia de la API', value: `${Math.round(client.ws.ping)}ms`, inline: true },
        { name: '⏱️ Tiempo encendido', value: uptimeTexto, inline: true },
        { name: '🏠 Servidores', value: String(client.guilds.cache.size), inline: true },
        { name: '📋 Comandos', value: String(client.commands.size), inline: true },
        { name: '📚 Node.js', value: process.version, inline: true }
      )
      .setFooter({ text: 'TriggerBOT' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
