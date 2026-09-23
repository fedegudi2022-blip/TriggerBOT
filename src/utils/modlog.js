const { EmbedBuilder } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { COLORS } = require('./replies');

// Numeración de casos por servidor: cada acción de moderación queda identificada
// con un número (estilo Dyno/Carl-bot) para poder referenciarla en el staff.
function siguienteCaso(guildId) {
  let n = 1;
  setGuildConfig(guildId, (c) => {
    c.caso = (c.caso || 0) + 1;
    n = c.caso;
  });
  return n;
}

// Registra una acción de moderación en el canal configurado con el panel.
// Devuelve el número de caso (o null si no hay mod-log configurado): así la
// confirmación que ve el staff puede referenciarlo ("/casos #123").
function logAction(guild, { action, color = COLORS.error, target, moderator, reason, duration, extra }) {
  const config = getGuildConfig(guild.id);
  if (!config.modlog) return null;

  const channel = guild.channels.cache.get(config.modlog);
  if (!channel) return null;

  const caso = siguienteCaso(guild.id);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`Caso #${caso} — ${action}`)
    .setTimestamp()
    .setFooter({ text: `TriggerBOT • registro de moderación • moderador: ${moderator?.tag ?? 'sistema'}` });

  // Avatar del sancionado como miniatura, si tenemos el usuario real.
  if (target?.displayAvatarURL) {
    embed.setThumbnail(target.displayAvatarURL({ size: 128 }));
  }

  embed.addFields(
    {
      name: 'Usuario',
      value: target?.raw ?? `<@${target.id}> (\`${target.tag ?? target.id}\`)`,
      inline: true,
    },
    { name: 'Moderador', value: `<@${moderator?.id ?? guild.client.user.id}>`, inline: true }
  );

  if (duration) embed.addFields({ name: 'Duración', value: duration, inline: true });
  embed.addFields({ name: 'Razón', value: reason || '*Sin especificar*', inline: false });
  if (extra) embed.addFields({ name: 'Detalles', value: extra, inline: false });

  channel.send({ embeds: [embed] }).catch((error) => console.error(`[TriggerBOT] No se pudo registrar la acción en el mod-log: ${error.message}`));
  return caso;
}

module.exports = { logAction };
