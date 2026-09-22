// Tests de src/db/sync.js — restauración guild-por-guild contra una "base" simulada.
// Se inyecta un pool falso de mysql2/promise en el require-cache para que
// listar()/subir() hablen con un mapa en memoria: valida la lógica de decisión
// SIN tocar la red ni necesitar un servidor MySQL real.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-sync-'));

// ---------- Nube simulada (tabla bot_data) ----------
// La "base" guarda las filas como las guarda MariaDB: datos/valor como TEXTO JSON.
let nube = new Map(); // clave → fila { clave, guild_id, almacen, datos (string JSON), version }

// ---------- Pool falso de mysql2 (se inyecta ANTES de requerir sync) ----------
const poolFake = {
  on: () => {},
  end: async () => {},
  execute: async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    if (s.startsWith('CREATE TABLE')) return [{ warningStatus: 1 }];

    if (s.startsWith('INSERT INTO bot_data')) {
      const [clave, guildId, almacen, datos, version] = params;
      nube.set(clave, { clave, guild_id: guildId, almacen, datos, version });
      return [{ affectedRows: 1 }];
    }

    if (s.startsWith('SELECT clave, guild_id, almacen, datos, version')) {
      let filas = [...nube.values()];
      if (/WHERE guild_id IN/.test(s)) filas = filas.filter((f) => params.includes(f.guild_id));
      return [filas];
    }

    if (s.startsWith('SELECT datos, version')) {
      const fila = nube.get(params[0]);
      return [fila ? [fila] : []];
    }

    if (s.startsWith('DELETE FROM bot_data')) {
      const existia = nube.delete(params[0]);
      return [{ affectedRows: existia ? 1 : 0 }];
    }

    if (s.startsWith('INSERT INTO bot_stats') || s.startsWith('DELETE FROM bot_stats') || s.startsWith('SELECT clave FROM bot_stats')) {
      return [[]];
    }

    throw new Error(`SQL no simulado: ${s}`);
  },
};

// mariadb.js hace require('mysql2/promise') al cargar: le ponemos el pool falso
// en el require-cache antes de que sync.js (→ mariadb.js) lo cargue.
const RUTA_MYSQL = require.resolve('mysql2/promise');
require.cache[RUTA_MYSQL] = { id: RUTA_MYSQL, filename: RUTA_MYSQL, loaded: true, exports: { createPool: () => poolFake } };

// Con la BD "configurada", el módulo de sync queda activo.
process.env.DB_HOST = 'db.test';
process.env.DB_PORT = '3306';
process.env.DB_NAME = 'trigger-arena-db-test';
process.env.DB_USER = 'bot-test';
process.env.DB_PASSWORD = 'clave-de-prueba-no-real';

const sync = require('../src/db/sync');
const niveles = require('../src/niveles');

// Fila como vendría de la base: el texto JSON lo parsea mariadb.js al leer.
function filaDe(clave, guildId, almacen, datos, version = Date.now()) {
  return { clave, guild_id: guildId, almacen, datos: JSON.stringify(datos), version };
}

// Almacén de prueba con marcas por guild.
function almacenPrueba(nombre) {
  const datos = new Map(); // guildId → contenido
  const marcas = new Map();
  return {
    nombre,
    marcasPorGuild: () => Object.fromEntries(marcas),
    leer: (g) => datos.get(g) ?? {},
    escribir: (g, d) => {
      datos.set(g, d ?? {});
      marcas.set(g, Date.now());
    },
    tocar: (g) => marcas.set(g, Date.now()),
  };
}

beforeEach(() => {
  nube = new Map();
});

describe('restaurar() — decisión por guild y almacén', () => {
  test('sin datos ni locales ni en la base: resumen en ceros', async () => {
    const resumen = await sync.restaurar({});
    assert.deepEqual(resumen, { locales: 0, nube: 0, restaurados: 0, errores: 0 });
  });

  test('guild sin datos locales se descarga de la base (host nuevo)', async () => {
    const almacen = almacenPrueba('prueba');
    nube.set('prueba:g-nuevo', filaDe('prueba:g-nuevo', 'g-nuevo', 'prueba', { saludo: 'hola' }));

    const resumen = await sync.restaurar({ prueba: almacen });
    assert.equal(resumen.restaurados, 1);
    assert.deepEqual(almacen.leer('g-nuevo'), { saludo: 'hola' });
  });

  test('local más nuevo que la base: se SUBE, no se pisa', async () => {
    const almacen = almacenPrueba('prueba');
    const versionBaseVieja = Date.now() - 60_000;
    nube.set('prueba:g-local', filaDe('prueba:g-local', 'g-local', 'prueba', { saludo: 'viejo' }, versionBaseVieja));

    almacen.escribir('g-local', { saludo: 'nuevo-local' }); // marca = ahora > base
    const resumen = await sync.restaurar({ prueba: almacen });

    assert.equal(resumen.restaurados, 0, 'la copia vieja de la base no pisa al local nuevo');
    assert.equal(resumen.nube, 1, 'el local se agenda para subir');
    assert.deepEqual(almacen.leer('g-local'), { saludo: 'nuevo-local' });
  });

  test('base más nueva que el último cambio local conocido: se RESTAURA', async () => {
    const almacen = almacenPrueba('prueba');
    // El host recuerda un cambio viejo de este guild...
    almacen.tocar('g-rest');
    await new Promise((r) => setTimeout(r, 20));
    // ...y mientras tanto OTRO host subió una versión más nueva a la base.
    nube.set('prueba:g-rest', filaDe('prueba:g-rest', 'g-rest', 'prueba', { saludo: 'desde-la-base' }));

    const resumen = await sync.restaurar({ prueba: almacen });
    assert.equal(resumen.restaurados, 1);
    assert.deepEqual(almacen.leer('g-rest'), { saludo: 'desde-la-base' });
  });

  test('dos guilds con versiones distintas: cada uno decide por su cuenta', async () => {
    const almacen = almacenPrueba('prueba');
    // El host conoce ambos guilds; la base tiene una versión más nueva de gA
    // y una versión vieja de gB (que el host acaba de cambiar localmente).
    almacen.tocar('gA');
    await new Promise((r) => setTimeout(r, 20));
    nube.set('prueba:gA', filaDe('prueba:gA', 'gA', 'prueba', { n: 1 }));
    nube.set('prueba:gB', filaDe('prueba:gB', 'gB', 'prueba', { n: 0 }, Date.now() - 60_000));

    almacen.escribir('gB', { n: 99 }); // gB local nuevo → sube; gA con base más nueva → restaura

    const resumen = await sync.restaurar({ prueba: almacen });
    assert.equal(resumen.restaurados, 1, 'gA se restaura de la base');
    assert.equal(resumen.nube, 1, 'gB se sube');
    assert.deepEqual(almacen.leer('gA'), { n: 1 });
    assert.deepEqual(almacen.leer('gB'), { n: 99 });
  });

  test('un guild restaurado NO pisa los datos de otro (bug original del mtime)', async () => {
    const almacen = almacenPrueba('prueba');
    // El host tiene datos locales de DOS guilds; la base trae versión más nueva solo de g-otro.
    almacen.escribir('g-mio', { valor: 'local-mio' });
    almacen.tocar('g-otro'); // el host conoce el guild pero no hizo cambios recientes
    await new Promise((r) => setTimeout(r, 20));
    nube.set('prueba:g-otro', filaDe('prueba:g-otro', 'g-otro', 'prueba', { valor: 'base-otro' }));

    const resumen = await sync.restaurar({ prueba: almacen });
    assert.equal(resumen.restaurados, 1, 'solo g-otro se restaura');

    assert.deepEqual(almacen.leer('g-mio'), { valor: 'local-mio' }, 'el guild local conserva sus datos');
    assert.deepEqual(almacen.leer('g-otro'), { valor: 'base-otro' }, 'el guild de la base llega completo');
  });

  test('fila de un almacén desconocido se ignora sin errores', async () => {
    nube.set('fantasma:gX', filaDe('fantasma:gX', 'gX', 'fantasma', {}));
    const resumen = await sync.restaurar({});
    assert.equal(resumen.errores, 0);
  });
});

describe('marcarSucio() — subida con debounce', () => {
  test('agrupa cambios rápidos en una sola subida con los datos finales', async () => {
    const almacen = almacenPrueba('prueba');
    almacen.escribir('g-debounce', { v: 1 });
    sync.marcarSucio('g-debounce', 'prueba', () => almacen.leer('g-debounce'));
    sync.marcarSucio('g-debounce', 'prueba', () => almacen.leer('g-debounce'));
    sync.marcarSucio('g-debounce', 'prueba', () => ({ v: 3 }));

    await new Promise((r) => setTimeout(r, 3500)); // > debounce de 3 s
    const fila = nube.get('prueba:g-debounce');
    assert.ok(fila, 'la subida ocurrió');
    assert.deepEqual(JSON.parse(fila.datos), { v: 3 }, 'se subió el último estado, no el primero');
  });

  test('subirYa() envía inmediatamente', async () => {
    const almacen = almacenPrueba('prueba');
    almacen.escribir('g-ya', { v: 'ahora' });
    await sync.subirYa('g-ya', 'prueba', () => almacen.leer('g-ya'));
    assert.ok(nube.has('prueba:g-ya'));
  });
});

describe('integración con almacenes reales (niveles/warns)', () => {
  test('niveles expone marcas por guild y datos por guild coherentes', async () => {
    niveles.procesarMensaje('g-real', 'u-real', new Date(Date.UTC(2026, 8, 22, 12)));
    const marcas = niveles.marcasPorGuild();
    assert.ok(marcas['g-real'] > 0);
    assert.ok(Object.keys(niveles.leer('g-real')).includes('u-real'));
  });

  test('restaurar sobre niveles reales escribe sin corromper otros guilds', async () => {
    niveles.escribir('g-real-A', { xp: 1 });
    niveles.escribir('g-real-B', { viejo: true }); // B existe localmente (para que la base lo consulte)
    nube.set('niveles:g-real-B', filaDe('niveles:g-real-B', 'g-real-B', 'niveles', { 'u-x': { xp: 555 } }, Date.now() + 1000));

    const resumen = await sync.restaurar({ niveles: niveles });
    assert.equal(resumen.restaurados, 1);
    assert.equal(niveles.datosDe('g-real-B', 'u-x').xp, 555);
    assert.equal(niveles.datosDe('g-real-A', 'no-existe').xp, 0, 'A no fue tocado');
  });
});
