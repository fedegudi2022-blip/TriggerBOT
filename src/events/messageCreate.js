const { Events } = require('discord.js');
const { brandEmbed } = require('../utils/replies');
const { responderCharla, normalizar, EMOJIS_REACCION } = require('../utils/charla');
const { getGuildConfig } = require('../store');

// Limita el tamaño del buffer de mensajes recientes por canal para no crecer sin control.
const MAX_BUFFER = 100;

// Cooldown de charla: 1 respuesta por usuario cada 15 segundos.
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

// Probabilidad de que el bot responda con una reacción de emoji en vez de charla.
const PROBABILIDAD_REACCION = 0.25;

// Responde cuando alguien menciona al bot: a veces reacciona con un emoji y
// otras charla. La guía completa vive exclusivamente en /help.
async function manejarMencion(message) {
  const client = message.client;
  if (!message.mentions.users.has(client.user.id)) return;
  if (estaEnCooldown(message.author.id)) return;

  // Texto que quedó después de la mención: "@TriggerBOT hola" → "hola"
  const texto = normalizar(
    message.content
      .replaceAll(`<@${client.user.id}>`, '')
      .replaceAll(`<@!${client.user.id}>`, '')
      .trim()
  );

  // Ping rápido con formato del bot; el resto es charla.
  if (texto === 'ping') {
    const embed = brandEmbed({
      color: 0x57f287,
      title: '🏓 Pong!',
      description: `**Latencia de la API:** ${Math.round(client.ws.ping)}ms\nPara más detalle usá /ping.`,
    });
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  // A veces solo reacciona con un emoji; el resto del tiempo charla.
  if (Math.random() < PROBABILIDAD_REACCION) {
    const emoji = EMOJIS_REACCION[Math.floor(Math.random() * EMOJIS_REACCION.length)];
    return message.react(emoji).catch(() => {});
  }

  await message.reply({ content: responderCharla(texto) }).catch(() => {});
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message.guild || message.author?.bot) return;

    guardarEnBuffer(message);
    await manejarMencion(message);
  },
};
