const { Events } = require('discord.js');
const { logEvent } = require('../utils/log');

module.exports = {
  name: Events.MessageDelete,
  async execute(message) {
    if (!message.guild || message.author?.bot) return;

    const buffer = message.client.buffersMensajes.get(`${message.guild.id}:${message.channelId}`);
    const cached = buffer?.get(message.id);
    if (buffer) buffer.delete(message.id);

    const contenido = message.content || cached?.contenido;
    if (!contenido) return; // sin contenido registrado no hay nada útil que reportar

    const fragmentos = [];
    if (cached?.autorId) {
      fragmentos.push({ name: 'Autor', value: `<@${cached.autorId}> (\`${cached.autorTag}\`)`, inline: true });
      fragmentos.push({ name: 'Canal', value: `<#${message.channelId}>`, inline: true });
    } else if (message.author) {
      fragmentos.push({ name: 'Autor', value: `<@${message.author.id}> (\`${message.author.tag}\`)`, inline: true });
      fragmentos.push({ name: 'Canal', value: `<#${message.channelId}>`, inline: true });
    }
    fragmentos.push({ name: 'Mensaje', value: contenido.slice(0, 1024) });

    logEvent(message.guild, {
      color: 0xed4245,
      title: '🗑️ Mensaje borrado',
      description: null,
      fields: fragmentos,
    });
  },
};
