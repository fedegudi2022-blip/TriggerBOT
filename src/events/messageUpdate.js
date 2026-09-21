const { Events } = require('discord.js');
const { logEvent } = require('../utils/log');

module.exports = {
  name: Events.MessageUpdate,
  async execute(oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (oldMessage.content === newMessage.content) return;

    const antes = oldMessage.content || '*(no disponible — el bot arrancó después de que se enviara)*';
    if (!newMessage.content) return; // embeds/attachments: nada de texto que comparar

    logEvent(newMessage.guild, {
      color: 0xfee75c,
      title: '✏️ Mensaje editado',
      fields: [
        { name: 'Autor', value: `<@${newMessage.author.id}> (\`${newMessage.author.tag}\`)`, inline: true },
        { name: 'Canal', value: `<#${newMessage.channelId}>`, inline: true },
        { name: 'Antes', value: antes.slice(0, 1024) },
        { name: 'Después', value: newMessage.content.slice(0, 1024) },
      ],
    });
  },
};
