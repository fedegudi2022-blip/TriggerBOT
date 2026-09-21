const { EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../store');

// Registro general de eventos del servidor (mensajes borrados/editados, salidas,
// cambios de roles, etc.). Usa el canal de /config logs y, si no está configurado,
// cae al mod-log para no perder registros.
function canalDeLogs(guild) {
  const config = getGuildConfig(guild.id);
  const canalId = config.logs || config.modlog;
  if (!canalId) return null;
  return guild.channels.cache.get(canalId) ?? null;
}

function logEvent(guild, { color = 0x5865f2, title, description, fields, thumbnail }) {
  const channel = canalDeLogs(guild);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: 'Registro • TriggerBOT' })
    .setTimestamp();
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (fields?.length) embed.addFields(fields);
  if (thumbnail) embed.setThumbnail(thumbnail);

  channel
    .send({ embeds: [embed] })
    .catch((error) => console.error(`[TriggerBOT] No se pudo enviar el registro de eventos: ${error.message}`));
}

module.exports = { logEvent, canalDeLogs };
