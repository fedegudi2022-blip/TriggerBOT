// Sincronización con Supabase: respaldo maestro de todos los almacenes de datos.
//
// Cómo funciona:
// - Los 5 almacenes del bot (config, warns, niveles, afk, interacciones) siguen
//   escribiendo en data/*.json como siempre: la respuesta del bot nunca espera a la red.
// - Cada guardado dispara (con debounce de 3 s) una subida del almacén afectado a Supabase.
// - Al arrancar, se compara cada servidor con la nube y gana la copia más nueva:
//   si el host borró data/ o se corrompió un JSON, se recupera todo desde Supabase.
//
// Si Supabase no está configurado, todas las funciones son no-ops.

const { subir, descargar, estado } = require('./supabase');

const DEBOUNCE_MS = 3_000;
const pendientes = new Map(); // clave → timeout

// ---------- Subida con debounce ----------
// Se llama en cada guardado local. Agrupa ráfagas de cambios en una sola subida.
function marcarSucio(guildId, almacen, obtenerDatos) {
  if (!estado.configurada) return;
  const clave = `${almacen}:${guildId}`;
  clearTimeout(pendientes.get(clave));
  pendientes.set(
    clave,
    setTimeout(async () => {
      pendientes.delete(clave);
      try {
        const datos = obtenerDatos();
        await subir(clave, guildId, almacen, datos);
      } catch (error) {
        estado.ultimoError = error.message;
        console.error('[TriggerBOT] Supabase: error inesperado al subir', clave, error.message);
      }
    }, DEBOUNCE_MS)
  );
}

// Subida inmediata (sin debounce), para avisos importantes como "el bot fue expulsado".
async function subirYa(guildId, almacen, obtenerDatos) {
  if (!estado.configurada) return;
  const clave = `${almacen}:${guildId}`;
  clearTimeout(pendientes.get(clave));
  pendientes.delete(clave);
  try {
    await subir(clave, guildId, almacen, obtenerDatos());
  } catch (error) {
    estado.ultimoError = error.message;
    console.error('[TriggerBOT] Supabase: error inesperado en subida inmediata', clave, error.message);
  }
}

// ---------- Restauración al arrancar ----------
// Compara data/*.json con la nube y aplica la copia más nueva en cada almacén.
// Devuelve un resumen para el log de arranque.
async function restaurar(almacenes) {
  const resumen = { locales: 0, nube: 0, restaurados: 0, errores: 0 };

  if (!estado.configurada) return resumen;

  // Caso 1: no conocemos servidores todavía (data local vacía) → traemos todo lo que haya.
  // Para eso listamos las filas de la nube agrupadas por almacén.
  const clavesLocales = new Map(); // almacen → { [guildId]: mtimeMs }

  for (const [nombre, definicion] of Object.entries(almacenes)) {
    const claves = new Map();
    try {
      if (definicion.leerGuilds) {
        for (const [guildId, mtime] of Object.entries(definicion.leerGuilds())) claves.set(guildId, mtime);
      }
    } catch {
      /* sin datos locales para este almacén */
    }
    clavesLocales.set(nombre, claves);
  }

  const hayLocal = [...clavesLocales.values()].some((m) => m.size > 0);

  // Descargamos las filas de la nube. Si hay datos locales, solo pedimos los
  // servidores que conocemos; si no hay nada local, pedimos todo.
  const guildIds = new Set();
  for (const claves of clavesLocales.values()) for (const guildId of claves.keys()) guildIds.add(guildId);

  const filas = [];
  try {
    const { listar } = require('./supabase');
    filas.push(...(await listar(hayLocal && guildIds.size > 0 ? [...guildIds] : null)));
  } catch (error) {
    estado.ultimoError = error.message;
    console.error('[TriggerBOT] Supabase: no se pudo leer la nube al arrancar:', error.message);
    resumen.errores += 1;
    return resumen;
  }

  estado.conectado = true;

  for (const fila of filas) {
    const definicion = almacenes[fila.almacen];
    if (!definicion) continue;

    const mtimeLocal = clavesLocales.get(fila.almacen)?.get(fila.guild_id) ?? 0;
    const fechaNube = new Date(fila.version).getTime() || 0; // version guarda Date.now()

    resumen.locales += mtimeLocal > 0 ? 1 : 0;

    if (fechaNube > mtimeLocal) {
      // La nube está más nueva: sobrescribe el archivo local.
      try {
        definicion.escribir(fila.guild_id, fila.datos);
        resumen.restaurados += 1;
      } catch (error) {
        console.error('[TriggerBOT] Supabase: fallo al restaurar', fila.clave, error.message);
        resumen.errores += 1;
        continue;
      }
    } else {
      // Local igual o más nueva: se sube a la nube (respaldo al día).
      resumen.nube += 1;
      marcarSucio(fila.guild_id, fila.almacen, () => definicion.leer(fila.guild_id));
    }
  }

  return resumen;
}

module.exports = { marcarSucio, subirYa, restaurar };
