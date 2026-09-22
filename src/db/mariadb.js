// Cliente MySQL/MariaDB para TriggerBOT — SIN ORM.
// La web (TriGGer.Arena) y el bot comparten la MISMA base (trigger-arena-db en
// MariaDB 10.6). El bot usa SUS PROPIAS tablas con prefijo bot_ y las crea solo
// si no existen (CREATE TABLE IF NOT EXISTS al arrancar), así nunca toca las
// tablas de la web (usuarios, partidos, productos, etc.).
//
// ¿Por qué mysql2 y no el paquete `mysql` viejo? mysql2 soporta prepared
// statements reales, promesas y MariaDB 10.6 sin problemas, y es el estándar
// de facto. Las credenciales van en .env: DB_HOST, DB_PORT, DB_NAME, DB_USER,
// DB_PASSWORD (las mismas de la web).
//
// Diseño: el bot SIEMPRE escribe primero en su caché local (data/*.json, como
// siempre), y esta capa sube cada cambio a la base con debounce. Si la base
// falla o no está configurada, el bot funciona exactamente igual que antes.

const mysql = require('mysql2/promise');
const crearLogger = require('../logger');
const log = crearLogger('mariadb');

const HOST = process.env.DB_HOST || '';
const PORT = Number(process.env.DB_PORT || 3306);
const DATABASE = process.env.DB_NAME || '';
const USER = process.env.DB_USER || '';
const PASSWORD = process.env.DB_PASSWORD || '';

const configurada = Boolean(HOST && DATABASE && USER);
const TIMEOUT_MS = 10_000;

// ---------- Pool de conexiones ----------
// Un pool reutiliza conexiones TCP: cada consulta no abre un handshake nuevo.
let pool = null;
function obtenerPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: HOST,
      port: PORT,
      user: USER,
      password: PASSWORD,
      database: DATABASE,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: TIMEOUT_MS,
      // Wispbyte/hosting suele exponer la base vía TCP sin TLS: sin ssl.
      charset: 'utf8mb4',
      enableKeepAlive: true,
    });
    // Un error de conexión caída no debe tirar el proceso: el pool se recupera solo.
    pool.on('error', (error) => {
      estado.ultimoError = error?.message || String(error);
      estado.conectado = false;
      log.error('Error del pool de conexiones', error);
    });
  }
  return pool;
}

// ---------- Estado de conexión (lo muestra /status) ----------
const estado = {
  configurada,
  conectado: false,
  permisoEscritura: null, // null = sin probar; false = el usuario no puede escribir
  ultimoError: null,
  subidasOk: 0,
  subidasFallidas: 0,
  ultimaSync: null, // Date de la última subida exitosa
  tablasCreadas: false,
};

function anotarFallo(error) {
  estado.ultimoError = error?.message || String(error);
  estado.conectado = false;
}

// Detecta errores de permisos (falta de GRANT). Mensajes típicos de MySQL/MariaDB.
const ES_ERROR_PERMISO = /access denied|permission denied|command denied|insufficient privileges|ER_TABLEACCESS_DENIED_ERROR|1044|1142|1143/i;
let avisoPermisoEmitido = false;

function advertirPermiso() {
  estado.permisoEscritura = false;
  if (avisoPermisoEmitido) return;
  avisoPermisoEmitido = true;
  log.error(
    'MariaDB: la clave configurada NO tiene permiso de escritura sobre las tablas bot_.\n' +
    '  Casi seguro el usuario no tiene GRANT sobre la base. Solución (1 min):\n' +
    '  1. Panel del hosting → Bases de datos → usuario "' + USER + '".\n' +
    '  2. Dale ALL PRIVILEGES sobre la base "' + DATABASE + '" (o al menos SELECT/INSERT/UPDATE/DELETE/CREATE sobre bot_*).\n' +
    '  3. Revisá DB_HOST/DB_PORT/DB_USER/DB_PASSWORD y reiniciá.\n' +
    '  Mientras tanto el bot sigue funcionando con datos locales (data/).'
  );
}

// ---------- Ejecución parametrizada ----------
// `sql` con placeholders ? y `params` array: cero concatenación de strings
// con datos del usuario → sin riesgo de inyección SQL.
async function ejecutar(sql, params = []) {
  const [resultado] = await obtenerPool().execute(sql, params);
  return resultado;
}

async function consultar(sql, params = []) {
  const [filas] = await obtenerPool().execute(sql, params);
  return filas;
}

// ---------- Esquema: el bot crea sus tablas bot_ si no existen ----------
// Un snapshot JSON por cada "almacén" de datos del bot (config, warns, niveles,
// afk, interacciones) para cada servidor. LONGTEXT + validación de JSON en la
// app: suficiente y sin dependencias de la versión de MariaDB (10.6 no tiene
// JSON real, usa LONGTEXT con CHECK json_valid()).
const SQL_TABLAS = [
  // Snapshot por guild+almacén (el respaldo maestro del bot).
  `CREATE TABLE IF NOT EXISTS bot_data (
    clave VARCHAR(100) NOT NULL PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL,
    almacen VARCHAR(32) NOT NULL,
    datos LONGTEXT NOT NULL,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    INDEX bot_data_guild_idx (guild_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Estadísticas globales del bot (claves sueltas: contadores de IA, ping...).
  `CREATE TABLE IF NOT EXISTS bot_stats (
    clave VARCHAR(100) NOT NULL PRIMARY KEY,
    valor LONGTEXT NOT NULL,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Puente web ↔ bot: la web inserta comandos acá y el bot los procesa cada 5 s.
  `CREATE TABLE IF NOT EXISTS bot_cmd (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    comando VARCHAR(64) NOT NULL,
    guild_id VARCHAR(32) NULL,
    argumentos LONGTEXT NOT NULL,
    creada_por VARCHAR(64) NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    procesado_en TIMESTAMP NULL DEFAULT NULL,
    resultado LONGTEXT NULL,
    INDEX bot_cmd_pendientes_idx (procesado_en, creado_en)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function asegurarTablas() {
  if (estado.tablasCreadas) return;
  for (const sql of SQL_TABLAS) {
    await ejecutar(sql); // CREATE TABLE no admite placeholders: es SQL fijo del módulo
  }
  estado.tablasCreadas = true;
}

// ---------- Utilidades JSON ----------
// Los JSON van como texto: se serializan/deserializan acá, un solo lugar.
function aJson(valor) {
  return JSON.stringify(valor ?? null);
}

function deJson(texto, respaldo = null) {
  if (texto === null || texto === undefined) return respaldo;
  try {
    return JSON.parse(texto);
  } catch {
    return respaldo;
  }
}

// ---------- Operaciones ----------

// Sube (inserta o actualiza) un almacén completo de un servidor.
async function subir(clave, guildId, almacen, datos) {
  if (!configurada) return false;
  try {
    await asegurarTablas();
    await ejecutar(
      `INSERT INTO bot_data (clave, guild_id, almacen, datos, version)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         guild_id = VALUES(guild_id),
         almacen = VALUES(almacen),
         datos = VALUES(datos),
         version = VALUES(version)`,
      [String(clave).slice(0, 100), String(guildId ?? '').slice(0, 32), String(almacen).slice(0, 32), aJson(datos), Date.now()]
    );
    estado.subidasOk += 1;
    estado.conectado = true;
    estado.ultimoError = null;
    estado.ultimaSync = new Date();
    return true;
  } catch (error) {
    estado.subidasFallidas += 1;
    if (ES_ERROR_PERMISO.test(error?.message || '')) advertirPermiso();
    anotarFallo(error);
    log.error('Fallo al subir', error, { clave });
    return false;
  }
}

// Descarga una fila por su clave. Devuelve { datos, version } o null.
async function descargar(clave) {
  if (!configurada) return null;
  try {
    const filas = await consultar('SELECT datos, version FROM bot_data WHERE clave = ? LIMIT 1', [String(clave)]);
    estado.conectado = true;
    const fila = filas?.[0];
    return fila ? { datos: deJson(fila.datos), version: Number(fila.version) } : null;
  } catch (error) {
    anotarFallo(error);
    log.error('Fallo al descargar', error, { clave });
    return null;
  }
}

// Consulta genérica para tablas del bot (lo usa el puente web para leer bot_cmd).
// Tabla limitada a la whitelist para no exponer cualquier tabla.
async function listarTabla(tabla, opciones = {}) {
  if (!configurada) return [];
  if (!/^(bot_data|bot_stats|bot_cmd)$/.test(tabla)) throw new Error(`Tabla no permitida: ${tabla}`);
  await asegurarTablas();
  const where = [];
  const params = [];
  for (const [col, valor] of Object.entries(opciones.filtros || {})) {
    // Columnas de la whitelist de cada tabla (los valores van parametrizados).
    if (!/^[a-z_]+$/.test(col)) throw new Error(`Columna inválida: ${col}`);
    if (valor === null) where.push(`${col} IS NULL`);
    else if (valor === 'is.null') where.push(`${col} IS NULL`);
    else {
      where.push(`${col} = ?`);
      params.push(valor);
    }
  }
  const clausulaWhere = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  let orden = '';
  if (opciones.orden) {
    const m = String(opciones.orden).match(/^([a-z_]+)\.(asc|desc)$/i);
    if (!m) throw new Error(`Orden inválido: ${opciones.orden}`);
    orden = ` ORDER BY ${m[1]} ${m[2].toUpperCase()}`;
  }
  const limite = Number.isInteger(opciones.limite) && opciones.limite > 0 ? ` LIMIT ${opciones.limite}` : '';
  const filas = await consultar(`SELECT * FROM ${tabla}${clausulaWhere}${orden}${limite}`, params);
  estado.conectado = true;
  // El puente espera JSON ya parseado en las columnas de datos.
  return (filas ?? []).map((fila) => ({
    ...fila,
    argumentos: fila.argumentos !== undefined ? deJson(fila.argumentos, {}) : undefined,
    resultado: fila.resultado !== undefined ? deJson(fila.resultado) : undefined,
    datos: fila.datos !== undefined ? deJson(fila.datos) : undefined,
    valor: fila.valor !== undefined ? deJson(fila.valor) : undefined,
    version: fila.version !== undefined ? Number(fila.version) : undefined,
  }));
}

// Lista filas de bot_data. Si `guildIds` es un array no vacío, filtra por esos
// servidores; si es null trae todo. Lanza el error (el que llama decide).
async function listar(guildIds = null) {
  if (!configurada) return [];
  await asegurarTablas();
  let sql = 'SELECT clave, guild_id, almacen, datos, version FROM bot_data';
  const params = [];
  if (Array.isArray(guildIds) && guildIds.length > 0) {
    sql += ` WHERE guild_id IN (${guildIds.map(() => '?').join(', ')})`;
    params.push(...guildIds.map(String));
  }
  const filas = await consultar(sql, params);
  estado.conectado = true;
  return (filas ?? []).map((fila) => ({
    clave: fila.clave,
    guild_id: fila.guild_id,
    almacen: fila.almacen,
    datos: deJson(fila.datos),
    version: Number(fila.version),
  }));
}

// Elimina una fila por clave.
async function eliminar(clave) {
  if (!configurada) return false;
  try {
    await asegurarTablas();
    await ejecutar('DELETE FROM bot_data WHERE clave = ?', [String(clave)]);
    return true;
  } catch (error) {
    if (ES_ERROR_PERMISO.test(error?.message || '')) advertirPermiso();
    anotarFallo(error);
    log.error('Fallo al eliminar', error, { clave });
    return false;
  }
}

// Actualiza campos de una fila de una tabla (lo usa el puente web para marcar
// comandos como procesados con su resultado). Devuelve true si fue OK.
async function actualizar(tabla, filtros, campos) {
  if (!configurada) return false;
  try {
    await asegurarTablas();
    if (!/^(bot_data|bot_stats|bot_cmd)$/.test(tabla)) throw new Error(`Tabla no permitida: ${tabla}`);
    const sets = [];
    const params = [];
    const valores = { ...campos };
    // El puente manda resultado como objeto: serializamos columnas de JSON.
    if (tabla === 'bot_cmd' && valores.resultado !== undefined) valores.resultado = aJson(valores.resultado);
    if (tabla === 'bot_data' && valores.datos !== undefined) valores.datos = aJson(valores.datos);
    if (tabla === 'bot_stats' && valores.valor !== undefined) valores.valor = aJson(valores.valor);
    if (tabla === 'bot_cmd') valores.procesado_en = valores.procesado_en ?? new Date();
    for (const [col, valor] of Object.entries(valores)) {
      if (!/^[a-z_]+$/.test(col)) throw new Error(`Columna inválida: ${col}`);
      sets.push(`${col} = ?`);
      params.push(valor instanceof Date ? valor.toISOString().slice(0, 19).replace('T', ' ') : valor);
    }
    const where = [];
    for (const [col, valor] of Object.entries(filtros)) {
      if (!/^[a-z_]+$/.test(col)) throw new Error(`Columna inválida: ${col}`);
      where.push(`${col} = ?`);
      params.push(String(valor));
    }
    if (!sets.length || !where.length) return false;
    await ejecutar(`UPDATE ${tabla} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`, params);
    estado.conectado = true;
    return true;
  } catch (error) {
    if (ES_ERROR_PERMISO.test(error?.message || '')) advertirPermiso();
    anotarFallo(error);
    log.error('Fallo al actualizar', error, { tabla });
    return false;
  }
}

// Ping real a la base (lo usan el arranque y /status).
// Además de leer, hace una prueba de escritura (sube y borra un ping):
// si la lectura va pero la escritura da error de permisos, el usuario es de solo lectura.
async function ping() {
  if (!configurada) return false;
  try {
    await consultar('SELECT clave FROM bot_stats LIMIT 1');
    estado.conectado = true;
    estado.ultimoError = null;
  } catch (error) {
    // Si las tablas todavía no existen, asegurarTablas() las crea y reintenta.
    try {
      await asegurarTablas();
      await consultar('SELECT clave FROM bot_stats LIMIT 1');
      estado.conectado = true;
      estado.ultimoError = null;
    } catch (error2) {
      anotarFallo(error2);
      return false;
    }
    anotarFallo(error);
  }
  try {
    await ejecutar(
      `INSERT INTO bot_stats (clave, valor) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      ['_ping', aJson({ t: Date.now() })]
    );
    await ejecutar('DELETE FROM bot_stats WHERE clave = ?', ['_ping']);
    estado.permisoEscritura = true;
    estado.tablasCreadas = true;
  } catch (error) {
    if (ES_ERROR_PERMISO.test(error?.message || '')) advertirPermiso();
    else estado.ultimoError = error?.message || String(error);
  }
  return true;
}

// Cierra el pool (lo llama el apagado controlado).
async function cerrar() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}

module.exports = { estado, configurada, subir, descargar, listar, listarTabla, eliminar, actualizar, ping, cerrar };
