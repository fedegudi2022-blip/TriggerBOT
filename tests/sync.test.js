// Tests de src/db/sync.js — restauración guild-por-guild contra una "nube" simulada.
// Se intercepta fetch para que listar()/subir() hablen con un mapa en memoria:
// valida la lógica de decisión SIN tocar la red.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-sync-'));

const NIVELES_URL = 'https://supabase.test';

// ---------- Nube simulada (tabla bot_data) ----------
let nube = new Map(); // clave → fila { clave, guild_id, almacen, datos, version }

const fetchReal = global.fetch;
function instalarNube() {
  global.fetch = async (url, opciones = {}) => {
    // listar() codifica el filtro guild_id=in.(...) con encodeURIComponent: decodificamos
    // la URL para poder aplicar el filtro en el simulador.
    const u = decodeURIComponent(String(url));
    if (u.startsWith(NIVELES_URL) && opciones.method === 'POST') {
      const cuerpo = JSON.parse(opciones.body)[0];
      nube.set(cuerpo.clave, { ...cuerpo, version: Date.now() });
      return { ok: true, status: 200, text: async () => '' };
    }
    if (u.startsWith(NIVELES_URL) && u.includes('select=clave,guild_id,almacen,datos,version')) {
      let filas = [...nube.values()];
      const m = u.match(/guild_id=in\.\(([^)]*)\)/);
      if (m) {
        const ids = m[1].split(',').map((s) => s.replaceAll('"', ''));
        filas = filas.filter((f) => ids.includes(f.guild_id));
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(filas) };
    }
    throw new Error(`fetch no simulado: ${u}`);
  };
}
function desinstalarNube() {
  global.fetch = fetchReal;
}

// Con Supabase "configurado", el módulo de sync queda activo.
process.env.SUPABASE_URL = NIVELES_URL;
process.env.SUPABASE_KEY = 'clave-de-prueba-no-real';

const sync = require('../src/db/sync');
const niveles = require('../src/niveles');

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
  instalarNube();
});

describe('restaurar() — decisión por guild y almacén', () => {
  test('sin datos ni locales ni en la nube: resumen en ceros', async () => {
    const resumen = await sync.restaurar({});
    assert.deepEqual(resumen, { locales: 0, nube: 0, restaurados: 0, errores: 0 });
  });

  test('guild sin datos locales se descarga de la nube (host nuevo)', async () => {
    const almacen = almacenPrueba('prueba');
    nube.set('prueba:g-nuevo', { clave: 'prueba:g-nuevo', guild_id: 'g-nuevo', almacen: 'prueba', datos: { saludo: 'hola' }, version: Date.now() });

    const resumen = await sync.restaurar({ prueba: almacen });
    assert.equal(resumen.restaurados, 1);
    assert.deepEqual(almacen.leer('g-nuevo'), { saludo: 'hola' });
  });

  test('local más nuevo que la nube: se SUBE, no se pisa', async () => {
    const almacen = almacenPrueba('prueba');
    const versionNubeVieja = Date.now() - 60_000;
    nube.set('prueba:g-local', { clave: 'prueba:g-local', guild_id: 'g-local', almacen: 'prueba', datos: { saludo: 'viejo' }, version: versionNubeVieja });

    almacen.escribir('g-local', { saludo: 'nuevo-local' }); // marca = ahora > nube
    const resumen = await sync.restaurar({ prueba: almacen });

    assert.equal(resumen.restaurados, 0, 'la nube vieja no pisa al local nuevo');
    assert.equal(resumen.nube, 1, 'el local se agenda para subir');
    assert.deepEqual(almacen.leer('g-local'), { saludo: 'nuevo-local' });
  });

  test('nube más nueva que el último cambio local conocido: se RESTAURA', async () => {
    const almacen = almacenPrueba('prueba');
    // El host recuerda un cambio viejo de este guild...
    almacen.tocar('g-rest');
    await new Promise((r) => setTimeout(r, 20));
    // ...y mientras tanto OTRO host subió una versión más nueva a la nube.
    nube.set('prueba:g-rest', { clave: 'prueba:g-rest', guild_id: 'g-rest', almacen: 'prueba', datos: { saludo: 'desde-la-nube' }, version: Date.now() });

    const resumen = await sync.restaurar({ prueba: almacen });
    assert.equal(resumen.restaurados, 1);
    assert.deepEqual(almacen.leer('g-rest'), { saludo: 'desde-la-nube' });
  });

  test('dos guilds con versiones distintas: cada uno decide por su cuenta', async () => {
    const almacen = almacenPrueba('prueba');
    // El host conoce ambos guilds; la nube tiene una versión más nueva de gA
    // y una versión vieja de gB (que el host acaba de cambiar localmente).
    almacen.tocar('gA');
    await new Promise((r) => setTimeout(r, 20));
    nube.set('prueba:gA', { clave: 'prueba:gA', guild_id: 'gA', almacen: 'prueba', datos: { n: 1 }, version: Date.now() });
    nube.set('prueba:gB', { clave: 'prueba:gB', guild_id: 'gB', almacen: 'prueba', datos: { n: 0 }, version: Date.now() - 60_000 });

    almacen.escribir('gB', { n: 99 }); // gB local nuevo → sube; gA con nube más nueva → restaura

    const resumen = await sync.restaurar({ prueba: almacen });
    assert.equal(resumen.restaurados, 1, 'gA se restaura de la nube');
    assert.equal(resumen.nube, 1, 'gB se sube');
    assert.deepEqual(almacen.leer('gA'), { n: 1 });
    assert.deepEqual(almacen.leer('gB'), { n: 99 });
  });

  test('un guild restaurado NO pisa los datos de otro (bug original del mtime)', async () => {
    const almacen = almacenPrueba('prueba');
    // El host tiene datos locales de DOS guilds; la nube trae versión más nueva solo de g-otro.
    almacen.escribir('g-mio', { valor: 'local-mio' });
    almacen.tocar('g-otro'); // el host conoce el guild pero no hizo cambios recientes
    await new Promise((r) => setTimeout(r, 20));
    nube.set('prueba:g-otro', { clave: 'prueba:g-otro', guild_id: 'g-otro', almacen: 'prueba', datos: { valor: 'nube-otro' }, version: Date.now() });

    const resumen = await sync.restaurar({ prueba: almacen });
    assert.equal(resumen.restaurados, 1, 'solo g-otro se restaura');

    assert.deepEqual(almacen.leer('g-mio'), { valor: 'local-mio' }, 'el guild local conserva sus datos');
    assert.deepEqual(almacen.leer('g-otro'), { valor: 'nube-otro' }, 'el guild de la nube llega completo');
  });

  test('fila de un almacén desconocido se ignora sin errores', async () => {
    nube.set('fantasma:gX', { clave: 'fantasma:gX', guild_id: 'gX', almacen: 'fantasma', datos: {}, version: Date.now() });
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
    assert.deepEqual(fila.datos, { v: 3 }, 'se subió el último estado, no el primero');
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
    niveles.escribir('g-real-B', { viejo: true }); // B existe localmente (para que la nube lo consulte)
    nube.set('niveles:g-real-B', { clave: 'niveles:g-real-B', guild_id: 'g-real-B', almacen: 'niveles', datos: { 'u-x': { xp: 555 } }, version: Date.now() + 1000 });

    const resumen = await sync.restaurar({ niveles: niveles });
    assert.equal(resumen.restaurados, 1);
    assert.equal(niveles.datosDe('g-real-B', 'u-x').xp, 555);
    assert.equal(niveles.datosDe('g-real-A', 'no-existe').xp, 0, 'A no fue tocado');
  });
});
