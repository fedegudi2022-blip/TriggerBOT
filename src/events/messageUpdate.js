const { Events } = require('discord.js');
const { logEvent, cita } = require('../utils/log');
const { COLORS } = require('../utils/replies');

module.exports = {
  name: Events.MessageUpdate,
  async execute(oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (oldMessage.content === newMessage.content) return;
    if (!newMessage.content) return; // embeds/attachments: nada de texto que comparar

    const antes = oldMessage.content
      ? cita(oldMessage.content, 600)
      : '*no disponible — el bot arrancó después de que se enviara*';

    logEvent(newMessage.guild, {
      color: COLORS.warn,
      title: 'Mensaje editado',
      fields: [
        { name: 'Autor', value: `<@${newMessage.author.id}> (\`${newMessage.author.tag}\`)`, inline: true },
        { name: 'Canal', value: `<#${newMessage.channelId}>`, inline: true },
        { name: 'Ir al mensaje', value: `[Ver edición](${newMessage.url})`, inline: true },
        { name: 'Antes', value: antes },
        { name: 'Después', value: cita(newMessage.content, 600) },
      ],
    });
  },
};
