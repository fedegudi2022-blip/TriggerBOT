// Tests de /sanciones: quién está silenciado ahora, separando el rol Silenciado del
// silencio temporal (se levantan distinto y el staff necesita ver los dos).
//
// Fakes de Discord estilo objetos literales, como el resto de la suite. No se descarga
// nada de la red: el `fetch` de miembros es un fake que puede fallar a pedido.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-sanciones-'));

const comando = require('../src/commands/sanciones');
const store = require('../src/store');

const ROL_MUTE = 'rol-mute';
const HORA = 60 * 60 * 1000;

// ---------- Fakes ----------
function miembroFake({ id, nombre, muted = false, hasta = 0, bot = false }) {
  return {
    id,
    displayName: nombre ?? `usuario ${id}`,
    user: { id, username: `user${id}`, bot },
    roles: { cache: { has: (rol) => muted && rol === ROL_MUTE } },
    communicationDisabledUntilTimestamp: hasta,
    toString: () => `<@${id}>`,
  };
}

let contadorGuild = 0;
function guildFake(miembros, { memberCount = null, fetchFalla = false, llamadas = null } = {}) {
  const cache = new Map(miembros.map((m) => [m.id, m]));
  const guildId = `g-sanciones-${++contadorGuild}`;
  store.setGuildConfig(guildId, (c) => {
    c.muteRole = ROL_MUTE;
  });

  return {
    id: guildId,
    ownerId: 'dueno',
    memberCount: memberCount ?? cache.size,
    members: {
      cache: { size: cache.size, values: () => cache.values() },
      fetch: async () => {
        if (llamadas) llamadas.fetch += 1;
        if (fetchFalla) throw new Error('Missing Permissions');
        return cache;
      },
    },
  };
}

function interaccionFake(guild, { staff = true } = {}) {
  const respuestas = [];
  const interaccion = {
    guild,
    guildId: guild.id,
    user: { id: 'staff-1', username: 'staff' },
    member: { id: 'staff-1', roles: { cache: { has: () => false } }, permissions: { has: () => staff } },
    options: { getNumber: () => null },
    respuestas,
    deferido: null,
    async deferReply(opciones = {}) {
      interaccion.deferido = opciones;
    },
    async reply(payload) {
      respuestas.push(payload);
      return payload;
    },
    async editReply(payload) {
      respuestas.push(payload);
      return payload;
    },
  };
  return interaccion;
}

const efimero = (payload) => Boolean(payload?.flags && payload.flags & MessageFlags.Ephemeral);
// En el camino feliz la visibilidad la fija el defer (el editReply que lo sigue no lleva
// flags): es la misma regla que aplica Discord.
const efimeroDefer = (interaccion) => efimero(interaccion.deferido);
const embed = (interaccion) => interaccion.respuestas[0].embeds[0].data;
const campo = (e, prefijo) => (e.fields ?? []).find((f) => f.name.startsWith(prefijo));

describe('/sanciones', () => {
  test('es de staff: sin permiso avisa en efímero y no descarga nada', async () => {
    const llamadas = { fetch: 0 };
    const interaccion = interaccionFake(guildFake([miembroFake({ id: 'a', muted: true })], { memberCount: 10, llamadas }), { staff: false });

    await comando.execute(interaccion);

    assert.equal(llamadas.fetch, 0, 'no se descargan miembros para decir que no');
    assert.equal(interaccion.deferido, null, 'no difiere una respuesta de error');
    assert.equal(interaccion.respuestas.length, 1);
    assert.ok(efimero(interaccion.respuestas[0]), 'el aviso tiene que ser efímero');
    assert.equal(embed(interaccion).title, 'Solo staff');
  });

  test('separa el rol Silenciado del silencio temporal y saltea los vencidos', async () => {
    const ahora = Date.now();
    const interaccion = interaccionFake(
      guildFake([
        miembroFake({ id: 'a', nombre: 'Ana', muted: true }),
        miembroFake({ id: 'b', nombre: 'Beto', hasta: ahora + 2 * HORA }),
        miembroFake({ id: 'c', nombre: 'Ceci', hasta: ahora - HORA }), // ya venció
      ])
    );

    await comando.execute(interaccion);

    assert.ok(efimeroDefer(interaccion), 'la lista de sanciones es efímera');
    const e = embed(interaccion);
    assert.equal(e.description, '1 con rol Silenciado · 1 con silencio temporal.');

    const rol = campo(e, 'Rol Silenciado');
    assert.match(rol.name, /\(1\)/);
    assert.match(rol.value, /Ana/);
    assert.ok(!/Beto|Ceci/.test(rol.value), 'el rol solo lleva a quien lo tiene');

    const temporal = campo(e, 'Silencio temporal');
    assert.match(temporal.value, /Beto/);
    assert.ok(!/Ceci/.test(temporal.value), 'un silencio vencido ya no está activo');
  });

  test('ordena los silencios temporales del que vence primero al último', async () => {
    const ahora = Date.now();
    const interaccion = interaccionFake(
      guildFake([
        miembroFake({ id: 'a', nombre: 'Tarde', hasta: ahora + 6 * HORA }),
        miembroFake({ id: 'b', nombre: 'Temprano', hasta: ahora + 5 * 60 * 1000 }),
      ])
    );

    await comando.execute(interaccion);

    const lineas = campo(embed(interaccion), 'Silencio temporal').value.split('\n');
    assert.match(lineas[0], /Temprano/, 'primero el que se libera antes');
    assert.match(lineas[1], /Tarde/);
  });

  test('sin sanciones activas lo dice en una línea', async () => {
    const interaccion = interaccionFake(guildFake([miembroFake({ id: 'a', nombre: 'Ana' })]));

    await comando.execute(interaccion);

    const e = embed(interaccion);
    assert.equal(e.title, 'Sin sanciones activas');
    assert.equal(e.fields, undefined, 'no se llena de campos vacíos');
    assert.match(e.description, /Nadie tiene el rol Silenciado/);
  });

  test('sin rol de Silenciado configurado muestra solo los temporales', async () => {
    const guild = guildFake([miembroFake({ id: 'a', nombre: 'Ana', muted: true, hasta: Date.now() + HORA })]);
    store.setGuildConfig(guild.id, (c) => {
      c.muteRole = undefined;
    });

    const interaccion = interaccionFake(guild);
    await comando.execute(interaccion);

    const e = embed(interaccion);
    assert.equal(campo(e, 'Rol Silenciado'), undefined, 'sin rol configurado no hay nada que listar');
    assert.match(campo(e, 'Silencio temporal').value, /Ana/);
  });

  test('si no puede descargar la lista completa lo aclara', async () => {
    const llamadas = { fetch: 0 };
    const interaccion = interaccionFake(
      guildFake([miembroFake({ id: 'a', nombre: 'Ana', muted: true })], { memberCount: 40, fetchFalla: true, llamadas })
    );

    await comando.execute(interaccion);

    assert.equal(llamadas.fetch, 1, 'intenta completar la caché una vez');
    assert.match(embed(interaccion).footer.text, /no pude revisar la lista completa/);
  });

  test('aclara desde el arranque cuando el servidor es demasiado grande para descargarlo', async () => {
    const llamadas = { fetch: 0 };
    const interaccion = interaccionFake(
      guildFake([miembroFake({ id: 'a', nombre: 'Ana', muted: true })], { memberCount: 6000, llamadas })
    );

    await comando.execute(interaccion);

    assert.equal(llamadas.fetch, 0, 'no se descarga un servidor enorme por este comando');
    assert.match(embed(interaccion).footer.text, /no pude revisar la lista completa/);
  });
});
