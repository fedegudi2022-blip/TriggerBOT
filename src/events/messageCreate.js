const { Events } = require('discord.js');
const { construirGuia } = require('../utils/guia');
const { getGuildConfig } = require('../store');

// Limita el tamaño del buffer de mensajes recientes por canal para no crecer sin control.
const MAX_BUFFER = 100;

// Cooldown del sistema de guía: 1 respuesta por usuario cada 15 segundos.
const COOLDOWN_MS = 15_000;
const cooldowns = new Map();

function clave(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

// Guarda el mensaje en el buffer para poder mostrar su contenido en los logs de borrados/ediciones.
function guardarEnBuffer(message) {
  const config = getGuildConfig(message.guild.id);
  if (!config.logs && !config.modlog) return; // nada de logging configurado

  const key = clave(message.guild.id, message.channelId);
  const canal = message.client.buffersMensajes.get(key);
  const registro = { contenido: message.content, autorId: message.author.id, autorTag: message.author.tag };
  if (canal) {
    canal.set(message.id, registro);
    if (canal.size > MAX_BUFFER) {
      const first = canal.keys().next().value;
      canal.delete(first);
    }
  } else {
    message.client.buffersMensajes.set(key, new Map([[message.id, registro]]));
  }
}

// Devuelve true si el usuario está dentro del cooldown; si no, registra el intento.
// Limpia entradas viejas de tanto en tanto para que el Map no crezca para siempre.
function estaEnCooldown(userId) {
  const ahora = Date.now();
  const ultima = cooldowns.get(userId) ?? 0;
  if (ahora - ultima < COOLDOWN_MS) return true;
  cooldowns.set(userId, ahora);
  if (cooldowns.size > 500) {
    for (const [id, ts] of cooldowns) {
      if (ahora - ts >= COOLDOWN_MS) cooldowns.delete(id);
    }
  }
  return false;
}

// Responde cuando alguien menciona al bot: guía, o comando estilo prefijo (@TriggerBOT ping).
async function manejarMencion(message) {
  const client = message.client;
  if (!message.mentions.users.has(client.user.id)) return;
  if (estaEnCooldown(message.author.id)) return;

  // Texto que quedó después de la mención: "@TriggerBOT ping" → "ping"
  const texto = message.content
    .replaceAll(`<@${client.user.id}>`, '')
    .replaceAll(`<@!${client.user.id}>`, '')
    .trim()
    .toLowerCase();

  if (texto === 'ping') {
    const embed = brandEmbed({
      color: 0x57f287,
      title: '🏓 Pong!',
      description: `**Latencia de la API:** ${Math.round(client.ws.ping)}ms\nPara más detalle usá /ping.`,
    });
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  if (texto && !['ayuda', 'help', 'guia', 'guía', 'comandos'].includes(texto)) {
    return message
      .reply({
        content: `No reconozco \`${texto.slice(0, 50)}\` como comando... pero acá está la guía:`,
        embeds: [construirGuia(client)],
      })
      .catch(() => {});
  }

  return message.reply({ embeds: [construirGuia(client)] }).catch(() => {});
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message.guild || message.author?.bot) return;

    guardarEnBuffer(message);
    await manejarMencion(message);
  },
};
