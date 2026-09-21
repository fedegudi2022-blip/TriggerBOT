const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { estadoIA, getStatsIA } = require('../utils/ia');
const { brandEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Muestra el estado del bot: IAs, latencia y servicios'),

  async execute(interaction, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ia = await estadoIA();
    const stats = getStatsIA();

    const iaGemini = ia.gemini.configurada ? `\`${ia.gemini.modelo}\`` : '—';
    const iaGroq = ia.groq.configurada ? `\`${ia.groq.modelo}\`` : '—';
    const iaOk = ia.gemini.configurada || ia.groq.configurada;
    const totalRespuestas = stats.gemini + stats.groq + stats.local;
    const statsTexto =
      totalRespuestas === 0
        ? 'Sin conversaciones todavía'
        : `Groq: **${stats.groq}** · Gemini: **${stats.gemini}** · Local: **${stats.local}**`;
    const estadoIATexto = iaOk ? 'Operativa' : 'Sin claves configuradas';

    const uptime = process.uptime();
    const dias = Math.floor(uptime / 86400);
    const horas = Math.floor((uptime % 86400) / 3600);
    const minutos = Math.floor((uptime % 3600) / 60);
    const uptimeTexto = dias > 0 ? `${dias}d ${horas}h ${minutos}m` : horas > 0 ? `${horas}h ${minutos}m` : `${minutos}m`;

    const embed = new EmbedBuilder()
      .setTitle('Estado de TriggerBOT')
      .setColor(iaOk ? 0x57f287 : 0xfee75c)
      .setDescription(`**${estadoIATexto}** · ${client.guilds.cache.size} servidor(es) · ${client.commands.size} comandos`)
      .addFields(
        { name: 'IA principal (Groq)', value: iaGroq, inline: true },
        { name: 'IA de respaldo (Gemini)', value: iaGemini, inline: true },
        { name: 'Latencia', value: `${Math.round(client.ws.ping)}ms`, inline: true },
        { name: 'Respuestas de IA', value: statsTexto, inline: false },
        { name: 'Tiempo encendido', value: uptimeTexto, inline: true },
        { name: 'Memoria del proceso', value: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`, inline: true },
        { name: 'Node.js', value: process.version, inline: true }
      )
      .setFooter({ text: 'TriggerBOT' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
