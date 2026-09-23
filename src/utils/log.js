const { EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../store');
const { COLORS } = require('./replies');

// Registro general de eventos del servidor (mensajes borrados/editados, salidas,
// cambios de roles, etc.). Usa el canal de /config logs y, si no está configurado,
// cae al mod-log para no perder registros.
function canalDeLogs(guild) {
  const config = getGuildConfig(guild.id);
  const canalId = config.logs || config.modlog;
  if (!canalId) return null;
  return guild.channels.cache.get(canalId) ?? null;
}

// Envía un embed de evento con el formato profesional unificado.
function logEvent(guild, { color = COLORS.info, title, description, fields, thumbnail }) {
  const channel = canalDeLogs(guild);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setTimestamp()
    .setFooter({ text: 'Registro de eventos • TriggerBOT' });

  if (description) embed.setDescription(description);
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (fields?.length) embed.addFields(fields);

  channel
    .send({ embeds: [embed] })
    .catch((error) => console.error(`[TriggerBOT] No se pudo enviar el registro de eventos: ${error.message}`));
}

// Formatea un fragmento de texto como cita (para contenido de mensajes).
function cita(texto, max = 1000) {
  const limpio = String(texto).slice(0, max);
  return limpio.split('\n').map((l) => `> ${l}`).join('\n');
}

// Formatea el tiempo transcurrido de forma legible.
function tiempoRelativo(ms) {
  const minutos = Math.floor(ms / 60000);
  if (minutos < 1) return 'menos de un minuto';
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${horas} h ${minutos % 60} min`;
  const dias = Math.floor(horas / 24);
  return `${dias} d`;
}

module.exports = { logEvent, canalDeLogs, cita, tiempoRelativo };
