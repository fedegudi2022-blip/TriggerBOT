// Registra los comandos slash. Con GUILD_ID definido se registran al instante
// en tu servidor (ideal para desarrollo); si falta, se registran globalmente.

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Faltan DISCORD_TOKEN o CLIENT_ID en el .env');
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  commands.push(require(path.join(commandsPath, file)).data.toJSON());
}

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ ${commands.length} comandos registrados en el servidor ${GUILD_ID} (instantáneo).`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log(`✅ ${commands.length} comandos registrados globalmente (puede tardar hasta 1 hora).`);
    }
  } catch (error) {
    console.error('Error al registrar comandos:', error);
    process.exit(1);
  }
})();
