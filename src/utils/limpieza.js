// Limpieza de datos al ser expulsado el bot de un servidor.
// Borra la entrada del guild en los caches, reescribe los archivos locales
// y elimina las filas correspondientes en Supabase.

const { supabase, estado } = require('../db/supabase');

async function limpiarGuild(guildId, almacenes) {
  for (const nombre of almacenes) {
    try {
      // Resuelve el módulo por nombre (evita dependencias circulares).
      const rutas = {
        config: '../store',
        warns: '../warns',
        niveles: '../niveles',
        afk: '../commands/afk',
        interacciones: './interacciones',
      };
      const mod = require(rutas[nombre]);
      if (!mod) continue;

      if (typeof mod.escribir === 'function') mod.escribir(guildId, nombre === 'config' ? {} : undefined);
      else if (typeof mod.escribirGuild === 'function') mod.escribirGuild(guildId, undefined);

      if (estado.configurada && supabase) {
        await supabase.from('bot_data').delete().eq('clave', `${nombre}:${guildId}`);
      }
    } catch (error) {
      console.error(`[TriggerBOT] Limpieza: fallo en almacén ${nombre}:`, error.message);
    }
  }
}

module.exports = { limpiarGuild };
