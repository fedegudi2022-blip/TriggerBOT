const { Events } = require('discord.js');
const { getGuildConfig } = require('../store');

// Limita el tamaño del buffer de mensajes recientes por canal para no crecer sin control.
const MAX_BUFFER = 100;

function clave(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message.guild || message.author?.bot) return;

    const config = getGuildConfig(message.guild.id);
    if (!config.logs && !config.modlog) return; // nada de logging configurado

    const key = clave(message.guild.id, message.channelId);
    const canal = message.client.buffersMensajes.get(key);
    if (canal) {
      canal.set(message.id, { contenido: message.content, autorId: message.author.id, autorTag: message.author.tag });
      if (canal.size > MAX_BUFFER) {
        const first = canal.keys().next().value;
        canal.delete(first);
      }
    } else {
      message.client.buffersMensajes.set(
        key,
        new Map([[message.id, { contenido: message.content, autorId: message.author.id, autorTag: message.author.tag }]])
      );
    }
  },
};
