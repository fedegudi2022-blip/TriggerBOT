const { Events, ActivityType, REST, Routes } = require('discord.js');
const { estado } = require('../db/mariadb');
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

    // ---------- Base de datos (MariaDB): restaurar/respaldar al arrancar ----------
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
          console.warn(`[TriggerBOT] MariaDB: restauración con errores (${resumen.errores}). El bot sigue con datos locales.`);
        } else {
          console.log(
            `[TriggerBOT] Base de datos conectada: ${resumen.restaurados} restaurado(s) desde la base, ` +
            `${resumen.nube} respaldo(s) agendado(s).`
          );
        }
      } catch (error) {
        console.warn(`[TriggerBOT] MariaDB: no se pudo completar la restauración (${error.message}). El bot sigue con datos locales.`);
      }
    } else {
      console.log('[TriggerBOT] Base de datos no configurada (DB_HOST/DB_NAME/DB_USER): los datos se guardan solo en data/ local.');
    }

    client.user.setPresence({
      activities: [{ name: 'Moderando Trigger.Arena', type: ActivityType.Watching }],
      status: 'online',
    });

    // Precalienta la IA en background (listado de modelos de Groq/Gemini): la
    // primera respuesta tras el arranque no paga la demora del listado.
    require('../utils/ia').precalentar();

    // Canales de voz temporales: borra los que quedaron vacíos por un reinicio.
    require('../utils/voz').limpiarAlArrancar(client).catch(() => {});

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
