const { EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../store');

// Registra una acción de moderación en el canal configurado con /config modlog.
// Si no hay canal configurado, no hace nada.
function logAction(guild, { action, color = 0xed4245, target, moderator, reason, duration, extra }) {
  const config = getGuildConfig(guild.id);
  if (!config.modlog) return;

  const channel = guild.channels.cache.get(config.modlog);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ ${action}`)
    .setColor(color)
    .addFields(
      { name: 'Usuario', value: `<@${target.id}> (\`${target.tag ?? target.id}\`)`, inline: true },
      { name: 'Moderador', value: `<@${moderator.id}>`, inline: true },
      { name: 'Razón', value: reason || '*Sin especificar*', inline: false }
    )
    .setTimestamp();

  if (duration) embed.addFields({ name: 'Duración', value: duration, inline: true });
  if (extra) embed.addFields({ name: 'Detalles', value: extra, inline: false });

  channel.send({ embeds: [embed] }).catch((error) => console.error('[modlog]', error.message));
}

module.exports = { logAction };
