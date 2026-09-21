const { Events, ActivityType, REST, Routes } = require('discord.js');
const { estado } = require('../db/supabase');
const { restaurar } = require('../db/sync');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log(`[TriggerBOT] Sesión iniciada correctamente como ${client.user.tag}`);
    console.log(
      `[TriggerBOT] Servidores activos: ${client.guilds.cache.map((g) => g.name).join(', ') || 'ninguno'}`
    );
    console.log(`[TriggerBOT] Comandos cargados: ${client.commands.size}`);

    // ---------- Base de datos (Supabase): restaurar/respaldar al arrancar ----------
    if (estado.configurada) {
      try {
        const resumen = await restaurar({
          config: require('../store'),
          warns: require('../warns'),
          niveles: require('../niveles'),
          afk: require('../commands/afk'),
          interacciones: require('../utils/interacciones'),
        });
        if (resumen.errores) {
          console.warn(`[TriggerBOT] Supabase: restauración con errores (${resumen.errores}). El bot sigue con datos locales.`);
        } else {
          console.log(
            `[TriggerBOT] Supabase conectado: ${resumen.restaurados} restaurado(s) desde la nube, ` +
            `${resumen.nube} respaldo(s) agendado(s).`
          );
        }
      } catch (error) {
        console.warn(`[TriggerBOT] Supabase: no se pudo completar la restauración (${error.message}). El bot sigue con datos locales.`);
      }
    } else {
      console.log('[TriggerBOT] Supabase no configurado: los datos se guardan solo en data/ local.');
    }

    client.user.setPresence({
      activities: [{ name: 'Moderando Trigger.Arena', type: ActivityType.Watching }],
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
