const { Events } = require('discord.js');
const { logEvent, cita, tiempoRelativo } = require('../utils/log');
const { COLORS } = require('../utils/replies');

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
    const autorNombre = cached?.autorNombre ?? message.author?.username ?? message.author?.tag ?? 'desconocido';
    const edad = message.createdTimestamp ? tiempoRelativo(Date.now() - message.createdTimestamp) : null;

    const fields = [
      { name: 'Autor', value: `<@${autorId}> (\`${autorNombre}\`)`, inline: true },
      { name: 'Canal', value: `<#${message.channelId}>`, inline: true },
    ];
    if (edad) fields.push({ name: 'Enviado', value: `hace ${edad}`, inline: true });
    fields.push({ name: 'Contenido', value: cita(contenido) });

    logEvent(message.guild, {
      color: COLORS.error,
      title: 'Mensaje borrado',
      fields,
    });
  },
};
