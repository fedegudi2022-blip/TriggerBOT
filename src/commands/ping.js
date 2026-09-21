const { SlashCommandBuilder } = require('discord.js');
const { brandEmbed, duracion, UMBRALES, nivel } = require('../utils/replies');

// Rótulos de cada parte del viaje del mensaje, para mostrarlo como "estaciones".
const TRAMOS = [
  { nombre: 'Acá al servidor', clave: 'ida' },
  { nombre: 'Ida y vuelta al servidor', clave: 'total' },
  { nombre: 'Discord (API)', clave: 'api' },
];

function tramo(valor, umbral) {
  const n = nivel(valor, umbral);
  return `${n.emoji} **${valor} ms** — ${n.texto}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Comprueba que el bot está vivo y su latencia'),

  async execute(interaction, client) {
    const sent = await interaction.reply({ content: '🏓 Midiendo...', fetchReply: true });

    // Antes del primer heartbeat, Discord.js reporta -1: mostramos "midiendo".
    const apiBruta = Math.round(client.ws.ping);
    const api = apiBruta >= 0 ? apiBruta : null;
    const total = sent.createdTimestamp - interaction.createdTimestamp;
    const ida = Math.round(total / 2);
    const calidad = nivel(Math.max(api ?? 0, total), UMBRALES.ping);

    const embed = brandEmbed({
      color: calidad.emoji === '🟢' ? 0x57f287 : calidad.emoji === '🟡' ? 0xfee75c : 0xed4245,
      title: '🏓 Pong!',
      description: `El bot está vivo y responde. Estado general: ${calidad.emoji} **${calidad.texto}**`,
      fields: TRAMOS.map((t) => ({
        name: t.nombre,
        value:
          t.clave === 'api' && api === null
            ? '⏳ Midiendo...'
            : tramo(t.clave === 'ida' ? ida : t.clave === 'total' ? total : api, UMBRALES.ping),
        inline: true,
      })),
      footer: `TriggerBOT • encendido hace ${duracion(process.uptime())}`,
    });

    return interaction.editReply({ embeds: [embed], content: '' }).catch(() => {});
  },
};
