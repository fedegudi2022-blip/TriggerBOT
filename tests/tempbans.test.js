// Tests de src/utils/tempbans.js — duraciones de /tempban y desbaneo automático.
// Sin base de datos: la capa de sync queda en no-op y nada toca la red.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-tempbans-'));

const store = require('../src/store');
const tempbans = require('../src/utils/tempbans');

let contador = 0;

// Guild fake con modlog conectado (así logAction devuelve un número de caso real).
function guildFake({ unban = null, modlog = true } = {}) {
  contador += 1;
  const id = `g-tb-${contador}`;
  const enviados = [];
  const guild = {
    id,
    name: 'Server',
    client: { user: { id: 'bot-1' }, users: { fetch: async (userId) => ({ id: userId, send: async () => {} }) } },
    channels: { cache: new Map() },
    members: {
      unban: unban ?? (async () => {}),
    },
  };
  if (modlog) {
    const canal = {
      id: 'canal-modlog',
      send: async (payload) => {
        enviados.push(payload);
      },
    };
    guild.channels.cache.set('canal-modlog', canal);
  }
  guild.enviadosModlog = enviados;
  return guild;
}

function clienteFake(guilds) {
  return { guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } };
}

const conTempban = (guild, entradas, extras = {}) => store.escribir(guild.id, { tempbans: entradas, modlog: 'canal-modlog', ...extras });

beforeEach(() => {
  // Cada test usa un guild nuevo: el store es un archivo por proceso.
});

describe('parsearDuracion', () => {
  test('entiende segundos, minutos, horas y días', () => {
    assert.equal(tempbans.parsearDuracion('90s'), 90_000);
    assert.equal(tempbans.parsearDuracion('30m'), 30 * 60_000);
    assert.equal(tempbans.parsearDuracion('12h'), 12 * 3_600_000);
    assert.equal(tempbans.parsearDuracion('7d'), 7 * 86_400_000);
  });

  test('sin unidad asume minutos y tolera espacios y mayúsculas', () => {
    assert.equal(tempbans.parsearDuracion('45'), 45 * 60_000);
    assert.equal(tempbans.parsearDuracion('  2 H '), 2 * 3_600_000);
    assert.equal(tempbans.parsearDuracion('3dias'), 3 * 86_400_000);
  });

  test('lo que no entiende o queda fuera de rango devuelve null (no recorta en silencio)', () => {
    for (const malo of ['', '   ', 'abc', '5x', 'una semana', '0m', '-3h', '99999m']) {
      assert.equal(tempbans.parsearDuracion(malo), null, `${malo} debería ser inválido`);
    }
    // Fuera de la ventana permitida: 30 s muy poco, 45 días demasiado.
    assert.equal(tempbans.parsearDuracion('30s'), null);
    assert.equal(tempbans.parsearDuracion('45d'), null);
    // Los bordes SÍ valen.
    assert.equal(tempbans.parsearDuracion('1m'), 60_000);
    assert.equal(tempbans.parsearDuracion('30d'), 30 * 86_400_000);
  });
});

describe('formatearDuracion', () => {
  test('usa como mucho dos unidades y no inventa decimales', () => {
    assert.equal(tempbans.formatearDuracion(90_000), '90 s');
    assert.equal(tempbans.formatearDuracion(30 * 60_000), '30 min');
    assert.equal(tempbans.formatearDuracion(5_400_000), '1 h 30 min');
    assert.equal(tempbans.formatearDuracion(7 * 86_400_000), '7 d');
  });
});

describe('programar y cancelar', () => {
  test('programar reemplaza el pendiente anterior del mismo usuario', () => {
    const guild = guildFake();
    tempbans.programar(guild.id, { userId: 'u-1', hasta: 1000, razon: 'primero' });
    tempbans.programar(guild.id, { userId: 'u-2', hasta: 2000 });
    tempbans.programar(guild.id, { userId: 'u-1', hasta: 3000, razon: 'segundo' });

    const lista = tempbans.tempbansDe(guild.id);
    assert.equal(lista.length, 2);
    assert.equal(lista.find((t) => t.userId === 'u-1').hasta, 3000);
    assert.equal(lista.find((t) => t.userId === 'u-1').razon, 'segundo');
  });

  test('cancelar avisa si había algo y no deja una lista vacía guardada', () => {
    const guild = guildFake();
    tempbans.programar(guild.id, { userId: 'u-1', hasta: 1000 });

    assert.equal(tempbans.cancelar(guild.id, 'u-1'), true);
    assert.equal(tempbans.cancelar(guild.id, 'u-1'), false, 'la segunda vez ya no había nada');
    assert.equal(store.leer(guild.id).tempbans, undefined, 'sin pendientes no queda la clave');
  });
});

describe('procesar — desbaneo automático', () => {
  test('desbanea solo los vencidos, deja el caso y borra el pendiente', async () => {
    const guild = guildFake();
    const desbaneados = [];
    guild.members.unban = async (userId, razon) => {
      desbaneados.push({ userId, razon });
    };
    const ahora = Date.now();
    conTempban(guild, [
      { userId: 'vencido-1', hasta: ahora - 60_000, razon: 'spam', desde: ahora - 3_600_000 },
      { userId: 'vigente-1', hasta: ahora + 3_600_000, razon: 'otro' },
    ]);

    const resultados = await tempbans.procesar(clienteFake([guild]));

    assert.deepEqual(
      desbaneados.map((d) => d.userId),
      ['vencido-1']
    );
    assert.match(desbaneados[0].razon, /Baneo temporal vencido/);
    assert.deepEqual(
      resultados.map((r) => r.ok),
      [true]
    );

    const quedan = tempbans.tempbansDe(guild.id).map((t) => t.userId);
    assert.deepEqual(quedan, ['vigente-1'], 'el vigente sigue esperando');
    assert.equal(guild.enviadosModlog.length, 1, 'el caso quedó en el mod-log');
    assert.match(guild.enviadosModlog[0].embeds[0].data.title, /Baneo temporal vencido/);
  });

  test('avisa por DM al que vuelve', async () => {
    const guild = guildFake();
    const dms = [];
    guild.client.users.fetch = async (userId) => ({ id: userId, send: async (texto) => dms.push(texto) });
    conTempban(guild, [{ userId: 'vuelve-1', hasta: Date.now() - 1000 }]);

    await tempbans.procesar(clienteFake([guild]));

    assert.equal(dms.length, 1);
    assert.match(dms[0], /baneo temporal en \*\*Server\*\* terminó/);
  });

  test('si ya no estaba baneado (10026) se da por terminado sin drama', async () => {
    const guild = guildFake();
    guild.members.unban = async () => {
      const error = new Error('Unknown Ban');
      error.code = 10026;
      throw error;
    };
    conTempban(guild, [{ userId: 'raro-1', hasta: Date.now() - 1000 }]);

    const resultados = await tempbans.procesar(clienteFake([guild]));

    assert.equal(resultados[0].ok, true);
    assert.equal(store.leer(guild.id).tempbans, undefined, 'el pendiente se cierra igual');
  });

  test('un rechazo real NO dice que desbaneó y reintenta en la próxima pasada', async () => {
    const guild = guildFake();
    guild.members.unban = async () => {
      throw new Error('Missing Permissions');
    };
    conTempban(guild, [{ userId: 'testarudo-1', hasta: Date.now() - 1000 }]);

    const resultados = await tempbans.procesar(clienteFake([guild]));

    assert.equal(resultados[0].ok, false);
    assert.match(resultados[0].error, /Missing Permissions/);
    const pendiente = tempbans.tempbansDe(guild.id)[0];
    assert.equal(pendiente.userId, 'testarudo-1', 'sigue pendiente para reintentar');
    assert.equal(pendiente.intentos, 1);
    assert.equal(guild.enviadosModlog.length, 0, 'no se registra un desbaneo que no pasó');
  });

  test('tras 5 intentos fallidos se descarta y se avisa en el mod-log', async () => {
    const guild = guildFake();
    guild.members.unban = async () => {
      throw new Error('Missing Permissions');
    };
    conTempban(guild, [{ userId: 'imposible-1', hasta: Date.now() - 1000, intentos: 4 }]);

    const resultados = await tempbans.procesar(clienteFake([guild]));

    assert.equal(resultados[0].ok, false);
    assert.equal(resultados[0].descartado, true);
    assert.equal(store.leer(guild.id).tempbans, undefined, 'no se reintenta para siempre');
    assert.match(guild.enviadosModlog[0].embeds[0].data.title, /no se pudo desbanear/);
  });

  test('sin pendientes no toca la API', async () => {
    const guild = guildFake();
    let llamadas = 0;
    guild.members.unban = async () => {
      llamadas += 1;
    };

    const resultados = await tempbans.procesar(clienteFake([guild]));

    assert.deepEqual(resultados, []);
    assert.equal(llamadas, 0);
  });
});
