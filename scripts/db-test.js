// Diagnóstico de la base de datos MariaDB del bot.
// Uso:
//   npm run db:test                          → usa las variables DB_* del .env / panel
//   node scripts/db-test.js <host> [puerto]  → prueba un host alternativo (ej: el
//                                              hostname público que te dé el soporte)
//
// Verifica, en orden: conexión TCP → autenticación → base → tablas bot_ →
// permisos de escritura (inserta y borra un ping). Nunca muestra la contraseña.

require('dotenv').config();
const mysql = require('mysql2/promise');

const HOST = process.argv[2] || process.env.DB_HOST || '';
const PORT = Number(process.argv[3] || process.env.DB_PORT || 3306);
const DATABASE = process.env.DB_NAME || '';
const USER = process.env.DB_USER || '';
const PASSWORD = process.env.DB_PASSWORD || '';

const ok = (t) => console.log(`  ✅ ${t}`);
const mal = (t) => console.log(`  ❌ ${t}`);
const paso = (t) => console.log(`\n▸ ${t}`);

const PISTAS = {
  ECONNREFUSED: 'No hay MySQL en ese host:puerto. 127.0.0.1 solo sirve en la máquina de la base; si el bot corre en otro hosting, pedile al soporte el hostname público de la base.',
  ETIMEDOUT: 'Firewall: el puerto 3306 está bloqueado para la IP de acá. El hosting tiene que habilitar MySQL remoto.',
  ENOTFOUND: 'El hostname no existe: revisá la escritura.',
  ER_HOST_NOT_PRIVILEGED: 'El servidor rechazó esta IP: hay que autorizarla como host permitido para el usuario (panel → MySQL remoto, o %).',
  ER_ACCESS_DENIED_ERROR: 'Usuario o contraseña incorrectos.',
  ER_BAD_DB_ERROR: 'La base no existe en ese servidor.',
};

async function main() {
  console.log('TriggerBOT — diagnóstico de base de datos');
  console.log(`  host: ${HOST || '(sin definir)'}  puerto: ${PORT}  base: ${DATABASE || '(sin definir)'}  usuario: ${USER || '(sin definir)'}`);
  if (!HOST || !DATABASE || !USER) {
    mal('Faltan DB_HOST / DB_NAME / DB_USER. Configuralos en el .env o en el panel y volvé a correr esto.');
    process.exit(1);
  }

  let conn;
  try {
    paso('1) Conexión y autenticación');
    conn = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD, connectTimeout: 10_000 });
    ok(`Conectado a ${HOST}:${PORT} como ${USER}`);
  } catch (error) {
    mal(`${error.code || ''} ${error.message}`);
    if (PISTAS[error.code]) console.log(`  💡 ${PISTAS[error.code]}`);
    process.exit(1);
  }

  try {
    paso('2) Base de datos y version del servidor');
    const [[v]] = await conn.query('SELECT VERSION() AS v');
    ok(`Servidor: ${v.v}`);
    const [[dbActual]] = await conn.query('SELECT DATABASE() AS d');
    ok(`Base en uso: ${dbActual.d}`);
  } catch (error) {
    mal(`${error.code || ''} ${error.message}`);
    if (PISTAS[error.code]) console.log(`  💡 ${PISTAS[error.code]}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }

  try {
    paso('3) Tablas del bot (prefijo bot_)');
    const [tablas] = await conn.query("SHOW TABLES LIKE 'bot\\_%'");
    const nombres = tablas.map((f) => Object.values(f)[0]);
    const esperadas = ['bot_data', 'bot_stats', 'bot_cmd'];
    for (const esperada of esperadas) {
      if (nombres.includes(esperada)) {
        const [[c]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${esperada}\``);
        ok(`${esperada} existe (${c.n} fila(s))`);
      } else {
        mal(`${esperada} NO existe (se crea sola al arrancar el bot, o importá sql/schema.sql)`);
      }
    }
    const ajenas = tablas.length - esperadas.filter((e) => nombres.includes(e)).length;
    if (ajenas > 0) console.log(`  ℹ️  ${ajenas} tabla(s) bot_ adicional(es) (no son del bot, se ignoran)`);
  } catch (error) {
    mal(`${error.code || ''} ${error.message}`);
  }

  try {
    paso('4) Prueba de escritura (inserta y borra un ping en bot_stats)');
    await conn.query(
      'INSERT INTO bot_stats (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
      ['_ping_test', JSON.stringify({ t: Date.now() })]
    );
    await conn.query('DELETE FROM bot_stats WHERE clave = ?', ['_ping_test']);
    ok('Escritura y borrado OK: el usuario tiene los permisos que el bot necesita');
  } catch (error) {
    mal(`${error.code || ''} ${error.message}`);
    console.log('  💡 El usuario puede leer pero no escribir: pedí GRANT de SELECT/INSERT/UPDATE/DELETE/CREATE sobre la base.');
  }

  await conn.end().catch(() => {});
  console.log('\nListo. Si todo salió ✅, el bot debería conectarse con estas mismas credenciales.');
}

main().catch((e) => {
  console.error('Error inesperado:', e.message);
  process.exit(1);
});
