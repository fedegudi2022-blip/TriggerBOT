const { Events } = require('discord.js');
const { subirYa } = require('../db/sync');

// Cuando el bot sale de un servidor (expulsado o borrado), guarda una ficha
// final en la base y agenda la limpieza de sus datos locales y de la base.
// La limpieza va con 60 s de delay: si fue un reinicio del host con re-invitación,
// la restauración del próximo arranque vuelve a traer todo desde la base.
const ALMACENES = ['config', 'warns', 'niveles', 'afk', 'interacciones'];

module.exports = {
  name: Events.GuildDelete,
  async execute(guild) {
    console.log(`[TriggerBOT] Bot retirado del servidor "${guild.name}" (${guild.id}).`);

    await subirYa(guild.id, 'salida_guild', () => ({
      id: guild.id,
      nombre: guild.name,
      salida: new Date().toISOString(),
      miembros: guild.memberCount,
    }));

    setTimeout(() => {
      const { limpiarGuild } = require('../utils/limpieza');
      limpiarGuild(guild.id, ALMACENES).catch(() => {});
    }, 60_000).unref();
  },
};
