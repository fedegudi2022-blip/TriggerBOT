const { Events } = require('discord.js');
const { responderCharla, normalizar } = require('../utils/charla');
const { conversar } = require('../utils/ia');
const { pedirConfirmacion } = require('../utils/accionesIA');
const { getAFK, quitarAFK } = require('../commands/afk');
const { procesarMensaje, datosDe, xpParaNivel, canalAnuncios, LOGROS } = require('../niveles');
const { brandEmbed } = require('../utils/replies');
const { getGuildConfig } = require('../store');

// Limita el tamaño del buffer de mensajes recientes por canal para no crecer sin control.
const MAX_BUFFER = 100;

// Cooldown de charla: 1 respuesta por usuario cada 3 segundos (spam friendly).
const COOLDOWN_MS = 3_000;
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

// Anuncia subida de nivel o logros en el canal configurado (si existe).
async function anunciarProgreso(message, progreso) {
  if (!progreso.subio && progreso.logrosNuevos.length === 0) return;

  const canalId = canalAnuncios(message.guild.id);
  if (!canalId) return;
  const canal = message.guild.channels.cache.get(canalId);
  if (!canal) return;

  if (progreso.subio) {
    const faltan = xpParaNivel(progreso.nivelNuevo + 1) - datosDe(message.guild.id, message.author.id).xp;
    const embed = brandEmbed({
      color: 0xfee75c,
      title: '¡Subiste de nivel!',
      description:
        `**${message.author}** llegó al nivel **${progreso.nivelNuevo}**.\n` +
        `Le faltan **${Math.max(faltan, 0)} XP** para el nivel ${progreso.nivelNuevo + 1}.`,
    });
    await canal.send({ embeds: [embed] }).catch(() => {});
  }

  for (const logro of progreso.logrosNuevos) {
    const definicion = LOGROS.find((l) => l.id === logro);
    if (!definicion) continue;
    const embed = brandEmbed({
      color: 0xf1c40f,
      title: `${definicion.emoji} Logro desbloqueado: ${definicion.nombre}`,
      description: `**${message.author}** desbloqueó **${definicion.nombre}** — ${definicion.desc}.`,
    });
    await canal.send({ embeds: [embed] }).catch(() => {});
  }
}

// Responde cuando alguien menciona al bot: siempre contesta con un mensaje.
async function manejarMencion(message) {
  const client = message.client;
  if (!message.mentions.users.has(client.user.id)) return;

  // Si el staff apagó la IA en este servidor, el bot ignora las menciones.
  if (getGuildConfig(message.guild.id).iaActivada === false) return;

  if (estaEnCooldown(message.author.id)) return;

  // Texto que quedó después de la mención: "@TriggerBOT hola" → "hola"
  const texto = normalizar(
    message.content
      .replaceAll(`<@${client.user.id}>`, '')
      .replaceAll(`<@!${client.user.id}>`, '')
      .trim()
  );

  // Ping rápido con formato del bot; el resto es charla o acciones con IA.
  if (texto === 'ping') {
    const embed = brandEmbed({
      color: 0x57f287,
      title: 'Pong!',
      description: `**Latencia de la API:** ${Math.round(client.ws.ping)}ms\nPara más detalle usá /ping.`,
    });
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  // Indicador de "escribiendo" mientras la IA piensa.
  await message.channel.sendTyping().catch(() => {});

  // Chat con IA si está configurada; si falla o no hay clave, respaldo local.
  try {
    const respuesta = await conversar(message.author.id, texto || '(el usuario solo te mencionó)', {
      usuario: message.member?.displayName || message.author.username,
      canal: message.channel.name,
    });

    if (respuesta?.tipo === 'accion') {
      return pedirConfirmacion(message, respuesta);
    }
    if (respuesta?.tipo === 'chat' && respuesta.texto) {
      return message.reply({ content: respuesta.texto.slice(0, 2000) }).catch(() => {});
    }
  } catch (error) {
    console.warn(`[TriggerBOT] IA no disponible, uso respuesta local: ${error.message}`);
  }

  await message.reply({ content: responderCharla(texto) }).catch(() => {});
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message.guild || message.author?.bot) return;

    guardarEnBuffer(message);

    // Sistema de niveles: XP y logros (el anuncio es silencioso si no hay canal configurado).
    try {
      const progreso = procesarMensaje(message.guild.id, message.author.id);
      await anunciarProgreso(message, progreso);
    } catch (error) {
      console.error('[TriggerBOT] Error procesando niveles:', error.message);
    }

    // Si el usuario estaba AFK y volvió a hablar, se le saca la marca.
    if (getAFK(message.guild.id, message.author.id)) {
      quitarAFK(message.guildId ?? message.guild.id, message.author.id);
      await message.reply('Bienvenido de vuelta, te saqué la marca AFK.').catch(() => {});
    }

    // Si el mensaje menciona a alguien AFK, se avisa.
    for (const [userId] of message.mentions.users) {
      if (userId === message.author.id) continue;
      const afk = getAFK(message.guild.id, userId);
      if (afk) {
        const minutos = Math.floor((Date.now() - afk.desde) / 60000);
        const tiempo = minutos >= 60 ? `${Math.floor(minutos / 60)} h` : `${Math.max(minutos, 1)} min`;
        await message
          .reply(`😴 **${message.guild.members.cache.get(userId)?.displayName || 'Ese usuario'}** está AFK desde hace ${tiempo}: ${afk.motivo}`)
          .catch(() => {});
        break; // un solo aviso por mensaje
      }
    }

    await manejarMencion(message);
  },
};
