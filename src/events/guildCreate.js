const { Events } = require('discord.js');
const { subirYa } = require('../db/sync');

// Cuando el bot entra a un servidor nuevo, registra su ficha en la nube
// (fila "avisos_guild" en bot_data: fecha de entrada y miembros; útil para auditoría).
module.exports = {
  name: Events.GuildCreate,
  async execute(guild) {
    console.log(`[TriggerBOT] Bot agregado al servidor "${guild.name}" (${guild.id}).`);
    await subirYa(guild.id, 'avisos_guild', () => ({
      id: guild.id,
      nombre: guild.name,
      entrada: new Date().toISOString(),
      miembros: guild.memberCount,
    }));
  },
};
