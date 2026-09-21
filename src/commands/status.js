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
        : `🟢 Gemini: **${stats.gemini}** · ⚡ Groq: **${stats.groq}** · 💬 Local: **${stats.local}**`;

    const uptime = process.uptime();
    const dias = Math.floor(uptime / 86400);
    const horas = Math.floor((uptime % 86400) / 3600);
    const minutos = Math.floor((uptime % 3600) / 60);
    const uptimeTexto = dias > 0 ? `${dias}d ${horas}h ${minutos}m` : horas > 0 ? `${horas}h ${minutos}m` : `${minutos}m`;

    const embed = new EmbedBuilder()
      .setTitle('📊 Estado de TriggerBOT')
      .setColor(iaOk ? 0x57f287 : 0xfee75c)
      .addFields(
        { name: '🤖 IA principal (Gemini)', value: iaGemini, inline: true },
        { name: '⚡ IA de respaldo (Groq)', value: iaGroq, inline: true },
        { name: '📡 Latencia de la API', value: `${Math.round(client.ws.ping)}ms`, inline: true },
        { name: '📈 Respuestas de IA', value: statsTexto, inline: false },
        { name: '⏱️ Tiempo encendido', value: uptimeTexto, inline: true },
        { name: '🏠 Servidores', value: String(client.guilds.cache.size), inline: true },
        { name: '📚 Node.js', value: process.version, inline: true }
      )
      .setFooter({ text: 'TriggerBOT' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
