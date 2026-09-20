const { Events, ActivityType, REST, Routes } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log(`✅ TriggerBOT conectado como ${client.user.tag}`);
    console.log(`   Servidores: ${client.guilds.cache.map((g) => g.name).join(', ')}`);

    client.user.setPresence({
      activities: [{ name: 'la comunidad Trigger', type: ActivityType.Watching }],
      status: 'online',
    });

    // Auto-registro de comandos slash en cada servidor donde está el bot.
    // Así no hace falta correr "npm run register" después de cada cambio:
    // alcanza con reiniciar el bot.
    const body = [...client.commands.values()].map((c) => c.data.toJSON());
    const rest = new REST().setToken(client.token);
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body });
        console.log(`✅ ${body.length} comandos registrados en "${guild.name}"`);
      } catch (error) {
        console.error(`❌ Error registrando comandos en "${guild.name}":`, error.message);
      }
    }
  },
};
