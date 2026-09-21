const { Events } = require('discord.js');
const { logEvent, cita, tiempoRelativo } = require('../utils/log');

module.exports = {
  name: Events.MessageDelete,
  async execute(message) {
    if (!message.guild || message.author?.bot) return;

    const buffer = message.client.buffersMensajes.get(`${message.guild.id}:${message.channelId}`);
    const cached = buffer?.get(message.id);
    if (buffer) buffer.delete(message.id);

    const contenido = message.content || cached?.contenido;
    if (!contenido) return; // sin contenido registrado no hay nada útil que reportar

    const autorId = cached?.autorId ?? message.author?.id;
    const autorTag = cached?.autorTag ?? message.author?.tag;
    const edad = message.createdTimestamp ? tiempoRelativo(Date.now() - message.createdTimestamp) : null;

    const fields = [
      { name: 'Autor', value: `<@${autorId}> (\`${autorTag}\`)`, inline: true },
      { name: 'Canal', value: `<#${message.channelId}>`, inline: true },
    ];
    if (edad) fields.push({ name: 'Enviado', value: `hace ${edad}`, inline: true });
    fields.push({ name: 'Contenido', value: cita(contenido) });

    logEvent(message.guild, {
      color: 0xed4245,
      title: 'Mensaje borrado',
      fields,
    });
  },
};
