// Censo de miembros (utils/censo.js): la foto que alimenta «Humanos» y «En línea» de los
// canales de estadísticas. Se prueba con fakes, sin red: lo que importa es que nunca
// devuelva un número inventado (0 en línea cuando el intent no está, o una lista parcial
// contada como completa).

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-censo-'));

const { GatewayIntentBits } = require('discord.js');
const censo = require('../src/utils/censo');

function coleccion(items = []) {
  const mapa = new Map(items.map((i) => [i.id, i]));
  return {
    get: (id) => mapa.get(id),
    values: () => mapa.values(),
    get size() {
      return mapa.size;
    },
    filter: (fn) => coleccion([...mapa.values()].filter(fn)),
    [Symbol.iterator]: () => mapa.values(),
  };
}

function miembroFake(id, { bot = false, estado = null } = {}) {
  return { id, user: { id, bot }, presence: estado ? { status: estado } : null };
}

// El cliente decide si hay presencias: es lo único que consulta el módulo.
function clienteFake(conPresencias) {
  return {
    options: {
      intents: { has: (flag) => conPresencias === true && flag === GatewayIntentBits.GuildPresences },
    },
  };
}

function guildFake({ id = 'g1', conPresencias = true, miembros = [], fetch = null } = {}) {
  return {
    id,
    client: clienteFake(conPresencias),
    members: {
      fetch: fetch ?? (async () => coleccion(miembros)),
      cache: coleccion([]),
    },
  };
}

beforeEach(() => censo.reiniciar());

describe('censo de miembros', () => {
  test('la foto separa humanos de bots y cuenta solo las presencias conectadas', async () => {
    const guild = guildFake({
      miembros: [
        miembroFake('u1', { estado: 'online' }),
        miembroFake('u2', { estado: 'idle' }),
        miembroFake('u3'), // conectado pero invisible/desconectado: no tiene presencia
        miembroFake('b1', { bot: true, estado: 'online' }),
      ],
    });

    const datos = await censo.sembrar(guild);

    assert.equal(datos.miembros, 4);
    assert.equal(datos.bots, 1);
    assert.equal(datos.enLinea, 2, 'el bot y el miembro sin presencia no cuentan como en línea');
    assert.equal(datos.conPresencias, true);
  });

  test('sin Presence Intent no inventa un 0: el conteo queda sin dato', async () => {
    const guild = guildFake({
      conPresencias: false,
      miembros: [miembroFake('u1', { estado: 'online' }), miembroFake('u2', { estado: 'online' }), miembroFake('b1', { bot: true })],
    });

    const datos = await censo.sembrar(guild);

    assert.equal(datos.enLinea, null, 'sin intent, Discord no manda estados: mejor "sin dato" que 0');
    assert.equal(datos.bots, 1, 'el conteo de bots no necesita presencias');
    assert.equal(datos.miembros, 3);
  });

  test('un fetch que falla o que no devuelve una colección no deja una foto a medias', async () => {
    const falla = guildFake({
      fetch: async () => {
        throw new Error('sin permiso');
      },
    });
    assert.equal(await censo.sembrar(falla), null);
    assert.equal(censo.datosDe(falla.id).cuando, 0);

    // Caso real de los fakes de contrato: fetch devuelve un objeto suelto, no una colección.
    const raro = guildFake({ fetch: async () => ({ id: 'u1' }) });
    assert.equal(await censo.sembrar(raro), null);
    assert.equal(censo.guardado(raro.id), false);
  });

  test('sin foto previa los cambios de presencia no cuentan nada', () => {
    const guild = guildFake({});
    const presencia = { guild: { id: guild.id }, userId: 'u1', status: 'online' };

    assert.equal(censo.actualizarPresencia(null, presencia), false);
    assert.equal(censo.datosDe(guild.id).enLinea, null, 'contar sin foto sería un número inventado');
  });

  test('después de la foto, conectarse y desconectarse mueve el número al instante', async () => {
    const guild = guildFake({ miembros: [miembroFake('u1', { estado: 'online' }), miembroFake('u2')] });
    await censo.sembrar(guild);

    censo.actualizarPresencia(null, { guild: { id: guild.id }, userId: 'u2', status: 'online' });
    assert.equal(censo.datosDe(guild.id).enLinea, 2);

    censo.actualizarPresencia({ status: 'online' }, { guild: { id: guild.id }, userId: 'u1', status: 'offline' });
    assert.equal(censo.datosDe(guild.id).enLinea, 1, 'volver a desconectado tiene que sacarlo del conteo');
  });

  test('quien se va del servidor sale del conteo sin esperar la próxima foto', async () => {
    const guild = guildFake({ miembros: [miembroFake('u1', { estado: 'online' })] });
    await censo.sembrar(guild);

    assert.equal(censo.olvidarMiembro(guild.id, 'u1'), true);
    assert.equal(censo.datosDe(guild.id).enLinea, 0);
    assert.equal(censo.olvidarMiembro('guild-desconocido', 'u1'), false);
  });

  test('revisar respeta el filtro por servidor y no vuelve a descargar la foto fresca', async () => {
    const conDatos = guildFake({ id: 'g-con-stats' });
    const sinDatos = guildFake({ id: 'g-sin-stats' });
    const client = { guilds: { cache: coleccion([conDatos, sinDatos]) } };

    const primera = await censo.revisar(client, { donde: (g) => g.id === 'g-con-stats' });
    assert.deepEqual(primera, { sembrados: 1, salteados: 1, fallidos: 0 });

    // Segunda pasada: la foto sigue fresca, no se vuelve a bajar la lista de miembros
    // (los dos servidores quedan salteados: el filtrado y el que ya tiene foto).
    const segunda = await censo.revisar(client, { donde: (g) => g.id === 'g-con-stats' });
    assert.deepEqual(segunda, { sembrados: 0, salteados: 2, fallidos: 0 });

    const forzada = await censo.revisar(client, { donde: (g) => g.id === 'g-con-stats', forzar: true });
    assert.equal(forzada.sembrados, 1);
  });

  test('estado() publica lo medido de cada servidor', async () => {
    const guild = guildFake({ id: 'g9', miembros: [miembroFake('u1', { estado: 'online' }), miembroFake('b1', { bot: true })] });
    await censo.sembrar(guild);

    const [fila] = censo.estado();
    assert.deepEqual(
      { guildId: fila.guildId, enLinea: fila.enLinea, bots: fila.bots, miembros: fila.miembros },
      { guildId: 'g9', enLinea: 1, bots: 1, miembros: 2 }
    );
  });
});
