const { Events, ActivityType, REST, Routes } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log(`[TriggerBOT] Sesión iniciada correctamente como ${client.user.tag}`);
    console.log(
      `[TriggerBOT] Servidores activos: ${client.guilds.cache.map((g) => g.name).join(', ') || 'ninguno'}`
    );
    console.log(`[TriggerBOT] Comandos cargados: ${client.commands.size}`);

    client.user.setPresence({
      activities: [{ name: 'la comunidad Trigger', type: ActivityType.Watching }],
      status: 'online',
    });

    // Sincronización de comandos slash en cada servidor donde está el bot.
    // No hace falta correr "npm run register" manualmente: alcanza con reiniciar.
    const body = [...client.commands.values()].map((c) => c.data.toJSON());
    const rest = new REST().setToken(client.token);
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body });
        console.log(`[TriggerBOT] ${body.length} comandos sincronizados en "${guild.name}".`);
      } catch (error) {
        console.error(`[TriggerBOT] Error al sincronizar comandos en "${guild.name}": ${error.message}`);
      }
    }
  },
};
