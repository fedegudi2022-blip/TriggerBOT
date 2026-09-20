const { Events, ActivityType } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`✅ TriggerBOT conectado como ${client.user.tag}`);
    console.log(`   Servidores: ${client.guilds.cache.map((g) => g.name).join(', ')}`);

    client.user.setPresence({
      activities: [{ name: 'la comunidad Trigger', type: ActivityType.Watching }],
      status: 'online',
    });
  },
};
