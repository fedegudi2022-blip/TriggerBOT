// TriggerBOT — punto de entrada
// Bot privado para la comunidad Trigger. Sin base de datos: todo en memoria.

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

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

// ---------- Manejador de comandos slash ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(`Error en /${interaction.commandName}:`, error);
    const payload = { content: '❌ Ocurrió un error al ejecutar el comando.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// ---------- Errores globales (evita caídas por promesas rechazadas) ----------
process.on('unhandledRejection', (error) => console.error('unhandledRejection:', error));

// ---------- Visibilidad de conexión ----------
client.on('error', (error) => console.error('[discord] error:', error.message));
client.on('shardDisconnect', (event) => console.warn('[discord] desconectado, voy a reintentar...', event?.message ?? ''));
client.on('shardReconnecting', () => console.log('[discord] reconectando...'));

// ---------- Login con reintento y mensajes claros ----------
function iniciarSesion() {
  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    const mensaje = String(error?.message || error);
    if (/token/i.test(mensaje)) {
      console.error('❌ Token inválido o vacío. Revisá la variable DISCORD_TOKEN en Startup → Variables.');
      process.exit(1); // crash visible: Wispbyte lo reinicia cuando corrijas la variable
    }
    console.warn(`⚠️ No pude conectar con Discord (${mensaje}). Reintento en 60 segundos...`);
    setTimeout(iniciarSesion, 60_000);
  });
}

console.log('🚀 Iniciando TriggerBOT...');
iniciarSesion();
