// TriggerBOT — punto de entrada
// Bot privado para la comunidad Trigger. Persistencia: JSON local + Supabase como respaldo maestro.

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials, MessageFlags } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Buffer de mensajes recientes (para mostrar contenido en los logs de borrados/ediciones).
client.buffersMensajes = new Map();

// ---------- Carga de comandos slash (src/commands/*) ----------
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(`[AVISO] El comando "${file}" no tiene "data" o "execute" y se ignoró.`);
  }
}

// ---------- Eventos (src/events/*) ----------
const eventsPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'))) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

// ---------- Frase del día: publicación diaria a la hora configurada ----------
setInterval(async () => {
  try {
    const { getGuildConfig, setGuildConfig } = require('./store');
    for (const guild of client.guilds.cache.values()) {
      const config = getGuildConfig(guild.id);
      const frase = config.fraseDelDia;
      if (!frase?.canalId || !frase.frases?.length) continue;

      const horaArg = Number(
        new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).format(new Date())
      );
      const diaHoy = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date());
      if (frase.ultima === diaHoy || horaArg !== frase.hora) continue;

      const canal = guild.channels.cache.get(frase.canalId);
      if (!canal) continue;

      const elegida = frase.frases[Math.floor(Math.random() * frase.frases.length)];
      // El footer no renderiza menciones: resuelve <@ID> → @Nombre.
      let autor = (elegida.autor || 'Anónimo').trim();
      const marca = autor.match(/^<@!?(\d{17,20})>$/);
      if (marca) {
        const miembro = guild.members.cache.get(marca[1]) ?? (await guild.members.fetch(marca[1]).catch(() => null));
        if (miembro) autor = `@${miembro.displayName}`;
      }
      const { brandEmbed } = require('./utils/replies');
      await canal
        .send({
          embeds: [
            brandEmbed({
              color: 0x5865f2,
              title: 'Frase del día',
              description: `> ${elegida.texto}`,
              footer: `— ${autor} • TriggerBOT`,
            }),
          ],
        })
        .then(() => {
          setGuildConfig(guild.id, (c) => {
            c.fraseDelDia.ultima = diaHoy;
          });
        })
        .catch(() => {});
    }
  } catch (error) {
    console.error('[TriggerBOT] Error en la frase del día:', error.message);
  }
}, 60 * 1000).unref();

// ---------- Componentes interactivos (botones, selectores y modales) ----------
const { manejarBoton } = require('./utils/accionesIA');
const { manejarComponente } = require('./utils/configPanel');
const memeCmd = require('./commands/meme');
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('ia_accion:')) {
      await manejarBoton(interaction);
    } else if (interaction.isButton() && interaction.customId === 'meme:otro') {
      await memeCmd.boton(interaction);
    } else if (interaction.customId?.startsWith('cfg:')) {
      await manejarComponente(interaction);
    }
  } catch (error) {
    console.error('[TriggerBOT] Error en componente interactivo:', error);
    const payload = { content: 'Ocurrió un error con el panel.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// ---------- Manejador de comandos slash ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(`Error en /${interaction.commandName}:`, error);
    const payload = { content: '❌ Ocurrió un error al ejecutar el comando.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// ---------- Errores globales (evita caídas por promesas rechazadas) ----------
process.on('unhandledRejection', (error) => console.error('[TriggerBOT] Promesa rechazada no manejada:', error));

// ---------- Registro de eventos de conexión ----------
client.on('error', (error) => console.error(`[TriggerBOT] Error en la conexión con Discord: ${error.message}`));
client.on('shardDisconnect', (event) => console.warn(`[TriggerBOT] Conexión perdida con Discord. Reintentando automáticamente... ${event?.message ?? ''}`));
client.on('shardReconnecting', () => console.log('[TriggerBOT] Reconectando con Discord...'));

// ---------- Inicio de sesión con reintentos automáticos ----------
let intentos = 0;

function iniciarSesion() {
  intentos += 1;
  let respondio = false;

  // Si Discord no responde en 45 s (típico de un bloqueo de IP del nodo), se reintenta.
  const vigilante = setTimeout(() => {
    if (respondio) return;
    console.warn(
      `[TriggerBOT] Sin respuesta de Discord tras 45 s (intento ${intentos}). ` +
      'Causa probable: bloqueo temporal de la IP del nodo. Nuevo intento en 60 s.'
    );
    client.destroy().catch(() => {});
    setTimeout(iniciarSesion, 60_000);
  }, 45_000);

  client
    .login(process.env.DISCORD_TOKEN)
    .then(() => {
      respondio = true;
      clearTimeout(vigilante);
    })
    .catch((error) => {
      clearTimeout(vigilante);
      respondio = true;
      const mensaje = String(error?.message || error);
      if (/token/i.test(mensaje)) {
        console.error(
          '[TriggerBOT] ERROR CRÍTICO: token inválido o no definido. ' +
          'Verifique la variable DISCORD_TOKEN en el panel (Startup → Variables) y reinicie el servidor.'
        );
        process.exit(1);
      }
      console.warn(
        `[TriggerBOT] Fallo de conexión con Discord (intento ${intentos}): ${mensaje}. Nuevo intento en 60 s.`
      );
      client.destroy().catch(() => {});
      setTimeout(iniciarSesion, 60_000);
    });
}

console.log('[TriggerBOT] Inicializando TriggerBOT v1.0.0...');
iniciarSesion();
