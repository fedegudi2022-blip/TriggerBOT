// Sincronización con la base MariaDB: respaldo maestro de todos los almacenes de datos.
//
// Cómo funciona:
// - Los 5 almacenes del bot (config, warns, niveles, afk, interacciones) siguen
//   escribiendo en data/*.json como siempre: la respuesta del bot nunca espera a la red.
// - Cada guardado dispara (con debounce de 3 s) una subida del almacén afectado a la
//   base de datos de la web (trigger-arena-db, tablas bot_).
// - Al arrancar, se compara cada SERVIDOR con la nube y gana la copia más nueva.
//
// Versionado POR guildId+almacén: cada almacén expone marcas de tiempo por servidor
// (ver registrarTimestamps) y el bot mantiene en memoria el instante de su ÚLTIMO
// cambio local conocido. Así la restauración compara "cuándo cambió ESTE servidor
// en este host" contra "cuándo se subió ESTE servidor a la nube", y no el mtime
// compartido del archivo entero: un servidor ya no pisa los datos restaurados de
// otro y un servidor nuevo sin datos locales puede descargar su copia de la nube.
// Al arrancar, si la nube es más nueva que el último cambio local conocido, gana
// la nube (restauración); si no, se sube el local. relojLocalMasNuevo() además
// protege contra relojes atrasados del host.

const { subir, estado } = require('./mariadb');
const crearLogger = require('../logger');
const log = crearLogger('sync');

const DEBOUNCE_MS = 3_000;
const pendientes = new Map(); // clave → timeout

// Última marca de cambio local POR clave "almacen:guildId" (Date.now() al momento
// de marcar sucio). Es la unidad de comparación contra `version` de la nube.
const ultimoCambioLocal = new Map();

// Registra (o actualiza) la marca de cambio local de un servidor+almacén.
function tocar(guildId, almacen, cuando = Date.now()) {
  const clave = `${almacen}:${guildId}`;
  const previa = ultimoCambioLocal.get(clave) ?? 0;
  // Nunca retroceder: protege contra relojes de host atrasados respecto de la nube.
  ultimoCambioLocal.set(clave, Math.max(previa, cuando));
}

// Arranque: si la nube es más nueva que lo que el host recuerda, gana la nube.
// Sino, el local gana y se sube. Requiere que cada almacén pase sus timestamps
// POR guild (ver niveles.js → marcaDeCambio guildId).
function relojLocalMasNuevo(clave, mtimeLocalPorGuild) {
  const local = ultimoCambioLocal.get(clave) ?? mtimeLocalPorGuild ?? 0;
  return local;
}

// ---------- Subida con debounce ----------
// Se llama en cada guardado local. Agrupa ráfagas de cambios en una sola subida.
function marcarSucio(guildId, almacen, obtenerDatos) {
  if (!estado.configurada) return;
  tocar(guildId, almacen);
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
        log.error('Error inesperado al subir', error, { clave });
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
    log.error('Error inesperado en subida inmediata', error, { clave });
  }
}

// ---------- Restauración al arrancar ----------
// Compara data/*.json con la nube POR guildId+almacén y aplica la copia más nueva
// en cada par (guild, almacén). Devuelve un resumen para el log de arranque.
async function restaurar(almacenes) {
  const resumen = { locales: 0, nube: 0, restaurados: 0, errores: 0 };

  if (!estado.configurada) return resumen;

  // Marcas locales POR guild para cada almacén. Los módulos exponen
  // marcasPorGuild() (Map guildId → ts del último cambio de ESE guild) o, como
  // mínimo, leerGuilds() (igual semántica, heredada del diseño viejo con mtime).
  const marcasLocales = new Map(); // almacen → Map(guildId → ts)

  for (const [nombre, definicion] of Object.entries(almacenes)) {
    const marcas = new Map();
    try {
      const fuente = definicion.marcasPorGuild ?? definicion.leerGuilds;
      if (typeof fuente === 'function') {
        for (const [guildId, ts] of Object.entries(fuente.call(definicion))) marcas.set(guildId, ts);
      }
    } catch {
      /* sin datos locales para este almacén */
    }
    marcasLocales.set(nombre, marcas);
  }

  const hayLocal = [...marcasLocales.values()].some((m) => m.size > 0);

  // Descargamos las filas de la nube. Si hay datos locales, solo pedimos los
  // servidores que conocemos; si no hay nada local, pedimos todo.
  const guildIds = new Set();
  for (const marcas of marcasLocales.values()) for (const guildId of marcas.keys()) guildIds.add(guildId);

  const filas = [];
  try {
    const { listar } = require('./mariadb');
    filas.push(...(await listar(hayLocal && guildIds.size > 0 ? [...guildIds] : null)));
  } catch (error) {
    estado.ultimoError = error.message;
    log.error('No se pudo leer la nube al arrancar', error);
    resumen.errores += 1;
    return resumen;
  }

  estado.conectado = true;

  for (const fila of filas) {
    const definicion = almacenes[fila.almacen];
    if (!definicion) continue;

    const clave = `${fila.almacen}:${fila.guild_id}`;
    const marcaLocal = marcasLocales.get(fila.almacen)?.get(fila.guild_id) ?? 0;
    const fechaNube = new Date(fila.version).getTime() || 0; // version guarda Date.now()

    resumen.locales += marcaLocal > 0 ? 1 : 0;

    // La nube es más nueva que el ÚLTIMO CAMBIO LOCAL CONOCIDO de este guild:
    // la restauración es segura (el host no tiene cambios más recientes que pisar).
    if (fechaNube > relojLocalMasNuevo(clave, marcaLocal)) {
      try {
        definicion.escribir(fila.guild_id, fila.datos);
        resumen.restaurados += 1;
        tocar(fila.guild_id, fila.almacen, fechaNube); // sync interno: nube ya reflejada localmente
      } catch (error) {
        log.error('Fallo al restaurar', error, { clave: fila.clave });
        resumen.errores += 1;
        continue;
      }
    } else {
      // Local igual o más nuevo: se sube a la nube (respaldo al día).
      resumen.nube += 1;
      marcarSucio(fila.guild_id, fila.almacen, () => definicion.leer(fila.guild_id));
    }
  }

  // Respaldo inicial: almacenes con datos locales que la nube todavía no tiene.
  // En la primera conexión sube todo el historial existente (warns, niveles, config...).
  const clavesNube = new Set(filas.map((f) => f.clave));
  for (const [nombre, definicion] of Object.entries(almacenes)) {
    for (const guildId of marcasLocales.get(nombre)?.keys() ?? []) {
      if (clavesNube.has(`${nombre}:${guildId}`)) continue;
      resumen.nube += 1;
      marcarSucio(guildId, nombre, () => definicion.leer(guildId));
    }
  }

  return resumen;
}

// ---------- Apagado controlado ----------
// Vuelca a disco los cambios en memoria pendientes (los almacenes con debounce).
// `volcarTodo` lo implementa cada almacén; aquí solo se lo pide a los módulos.
function volcarTodo() {
  const rutas = ['../niveles', '../warns', '../store', '../commands/afk', './interacciones'];
  for (const ruta of rutas) {
    try {
      const mod = require(ruta);
      if (typeof mod.volcar === 'function') mod.volcar();
    } catch {
      /* módulo no cargado: nada que volcar */
    }
  }
}

// Espera a que terminen las subidas con debounce pendientes (máx. ~10 s).
async function esperarSubidasPendientes() {
  const inicio = Date.now();
  while (pendientes.size > 0 && Date.now() - inicio < 10_000) {
    await new Promise((r) => {
      setTimeout(r, 100);
    });
  }
  if (pendientes.size > 0) {
    log.warn(`Apagado: ${pendientes.size} subida(s) a la base de datos quedaron sin completar.`);
  }
}

module.exports = { marcarSucio, subirYa, restaurar, tocar, volcarTodo, esperarSubidasPendientes };
