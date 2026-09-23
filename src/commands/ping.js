// /ping — latencia del bot con indicadores de calidad y botón para refrescar
// la medición sin reescribir el comando. El mismo builder sirve para el slash y el botón.
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { brandEmbed, duracion, UMBRALES, nivel, COLORS } = require('../utils/replies');

// Rótulos de cada parte del viaje del mensaje, para mostrarlo como "estaciones".
const TRAMOS = [
  { nombre: 'Acá al servidor', clave: 'ida' },
  { nombre: 'Ida y vuelta al servidor', clave: 'total' },
  { nombre: 'Discord (API)', clave: 'api' },
];

const REFRESH_ID = 'ping:refresh';

function tramo(valor, umbral) {
  const n = nivel(valor, umbral);
  return `${n.emoji} **${valor} ms** — ${n.texto}`;
}

// Construye embed + botones de refresco con los valores de una medición ya hecha.
function vistaPing(client, medicion) {
  const { api, total, calidad } = medicion;
  const ida = Math.round(total / 2);

  const embed = brandEmbed({
    color: calidad.emoji === '🟢' ? COLORS.success : calidad.emoji === '🟡' ? COLORS.warn : COLORS.error,
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

  const fila = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(REFRESH_ID).setLabel('Refrescar').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [fila] };
}

// Mide el roundtrip: envía la respuesta "Midiendo..." y calcula con el timestamp del reply.
async function medir(interaction, client) {
  const sent = await interaction.reply({ content: '🏓 Midiendo...', fetchReply: true });

  // Antes del primer heartbeat, Discord.js reporta -1: mostramos "midiendo".
  const apiBruta = Math.round(client.ws.ping);
  const api = apiBruta >= 0 ? apiBruta : null;
  const total = sent.createdTimestamp - interaction.createdTimestamp;
  const calidad = nivel(Math.max(api ?? 0, total), UMBRALES.ping);

  return { api, total, calidad };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Comprueba que el bot está vivo y su latencia'),

  async execute(interaction, client) {
    const medicion = await medir(interaction, client);
    return interaction
      .editReply({ ...vistaPing(client, medicion), content: '' })
      .catch(() => {});
  },

  // Botón 🔄: re-mide sobre el mismo mensaje (editReply), sin nuevo comando.
  async boton(interaction, client) {
    await interaction.deferUpdate();
    // Roundtrip real: el ACK del botón llega con su propio timestamp; el tiempo
    // transcurrido hasta editar el mensaje es la latencia ida y vuelta de ahora.
    const sent = await interaction.editReply({ content: '🏓 Midiendo...', embeds: [], components: [] });
    const total = sent.createdTimestamp - interaction.createdTimestamp;

    const apiBruta = Math.round(client.ws.ping);
    const api = apiBruta >= 0 ? apiBruta : null;
    const calidad = nivel(Math.max(api ?? 0, total), UMBRALES.ping);

    await interaction.editReply(vistaPing(client, { api, total, calidad })).catch(() => {});
  },
};
