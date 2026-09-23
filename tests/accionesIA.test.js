// Tests de las órdenes de moderación por chat (utils/accionesIA.js): el panel de
// confirmación y la ejecución real, con Discord mockeado.
//
// Nacen del caso real: un miembro del staff pidió por chat "borrá todos los mensajes de
// este canal" y el bot contestó que no tenía permiso para borrar mensajes. Ahora la IA
// devuelve la acción (ver tests/ia.test.js), el panel la confirma y el bot borra de
// verdad — con los mismos límites que /clear y el mismo permiso que el comando.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-acciones-'));

const accionesIA = require('../src/utils/accionesIA');
const store = require('../src/store');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

const GUILD = 'g-acciones';
const BOT = 'bot-1';
const DUENO = 'dueno-1';
const DIA_MS = 86400_000;

// ---------- Fakes de Discord ----------
function miembroFake(id, { permisos = [], roles = [] } = {}) {
  return {
    id,
    tag: `${id}#0001`,
    user: { id, tag: `${id}#0001`, username: id },
    displayName: id,
    permissions: { has: (p) => permisos.includes(p) },
    roles: { cache: new Map(roles.map((r) => [r, {}])), highest: { position: 10 } },
    moderatable: true,
  };
}

// Canal con mensajes: registra qué se borró, con qué límite se pidieron los mensajes y
// qué se le configuró (modo lento / bloqueo). `delete` de un solo mensaje también suma.
function canalFake({ mensajes = [], fallaBorrado = false } = {}) {
  const borrados = [];
  const limites = [];
  const coleccion = new Map(
    mensajes.map(({ id, autor = 'alguien', antiguedadMs = 0 }) => [
      id,
      {
        id,
        author: { id: autor, tag: `${autor}#0001` },
        createdTimestamp: Date.now() - antiguedadMs,
        delete: async () => {
          if (fallaBorrado) throw new Error('Missing Permissions');
          borrados.push(id);
        },
      },
    ])
  );

  const canal = {
    id: 'canal-1',
    name: 'general',
    isTextBased: () => true,
    borrados,
    limites,
    rateLimitPerUser: 0,
    ultimoOverride: null,
    messages: {
      fetch: async ({ limit }) => {
        limites.push(limit);
        return new Map([...coleccion].slice(0, limit));
      },
    },
    bulkDelete: async (lista) => {
      if (fallaBorrado) throw new Error('Missing Permissions');
      for (const m of lista) borrados.push(m.id);
      return new Map(lista.map((m) => [m.id, m]));
    },
    setRateLimitPerUser: async (segundos) => {
      canal.rateLimitPerUser = segundos;
    },
    permissionOverwrites: {
      edit: async (_rol, permisos) => {
        canal.ultimoOverride = permisos;
      },
    },
    permissionsFor: () => ({ has: () => true }),
    toString: () => '<#canal-1>',
  };
  return canal;
}

function guildFake() {
  return {
    id: GUILD,
    ownerId: DUENO,
    client: { user: { id: BOT } },
    roles: { everyone: { id: 'everyone' }, cache: new Map() },
    channels: { cache: new Map(), fetch: async () => null },
    members: { me: { id: BOT }, fetch: async () => null },
  };
}

// Mensaje que mencionó al bot: lo único que hace es registrar lo que se le responde.
function mensajeFake({ guild, canal, miembro }) {
  const respuestas = [];
  return {
    respuestas,
    id: 'msg-1',
    guild,
    author: { id: miembro.id, tag: miembro.tag, username: miembro.id },
    member: miembro,
    channel: canal,
    client: { user: { id: BOT } },
    mentions: { members: new Map(), users: new Map() },
    reply: async (payload) => {
      respuestas.push(payload);
      return { id: `panel-${respuestas.length}` };
    },
  };
}

// Interacción de botón sobre el panel que devolvió `pedirConfirmacion`.
function botonFake({ mensaje, miembro, canal, customId = 'ia_accion:si' }) {
  const edits = [];
  const replies = [];
  return {
    edits,
    replies,
    customId,
    guild: mensaje.guild,
    guildId: GUILD,
    member: miembro,
    user: miembro.user,
    channel: canal,
    message: { id: `panel-${mensaje.respuestas.length}` },
    deferUpdate: async () => {},
    editReply: async (payload) => {
      edits.push(payload);
      return payload;
    },
    update: async (payload) => {
      edits.push(payload);
      return payload;
    },
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
  };
}

// Textos de un embed, para no depender de la estructura interna de discord.js.
const textoDe = (payload) => (payload?.embeds ?? []).map((e) => (e.data?.description ?? '') + (e.data?.title ?? '')).join(' ');

// Cada test usa un id de autor distinto: hay un cooldown de 20 s entre pedidos del
// MISMO usuario (anti-abuso), y los tests corren en milisegundos.

describe('órdenes de moderación por chat', () => {
  test('el staff pide borrar el canal: hay panel de confirmación y se borra de verdad', async () => {
    store.escribir(GUILD, {});
    const guild = guildFake();
    const canal = canalFake({
      mensajes: [
        { id: 'm1', autor: 'fulano' },
        { id: 'm2', autor: 'fulano' },
        { id: 'm3', autor: 'fulano' },
      ],
    });
    // Moderar miembros alcanza para las acciones sobre personas, pero /clear exige
    // Gestionar mensajes: acá se le da ese permiso, como a un staff real.
    const staff = miembroFake('staff-1', { permisos: [PermissionFlagsBits.ManageMessages] });
    const mensaje = mensajeFake({ guild, canal, miembro: staff });

    await accionesIA.pedirConfirmacion(mensaje, { accion: 'limpiar', cantidad: 100, motivo: 'ruido' });

    assert.equal(mensaje.respuestas.length, 1, 'se muestra el panel');
    assert.match(textoDe(mensaje.respuestas[0]), /Limpieza del canal/, 'el panel dice qué va a pasar');
    assert.match(textoDe(mensaje.respuestas[0]), /hasta 100/, 'y con qué límite');
    assert.ok(mensaje.respuestas[0].components?.length, 'tiene botones');

    const boton = botonFake({ mensaje, miembro: staff, canal });
    await accionesIA.manejarBoton(boton);

    assert.deepEqual(canal.borrados, ['m1', 'm2', 'm3'], 'se borraron los mensajes del canal');
    assert.match(textoDe(boton.edits.at(-1)), /Borré \*\*3\*\*/);
  });

  test('un miembro común no puede pedir una orden sobre el canal', async () => {
    store.escribir(GUILD, {});
    const guild = guildFake();
    const canal = canalFake({ mensajes: [{ id: 'm1' }, { id: 'm2' }] });
    const comun = miembroFake('comun-1');
    const mensaje = mensajeFake({ guild, canal, miembro: comun });

    await accionesIA.pedirConfirmacion(mensaje, { accion: 'limpiar', cantidad: 100 });

    assert.equal(mensaje.respuestas.length, 1);
    assert.match(textoDe(mensaje.respuestas[0]), /Solo el staff/, 'se le explica por qué no');
    assert.equal(mensaje.respuestas[0].components, undefined, 'y no queda nada para confirmar');
    assert.deepEqual(canal.borrados, [], 'no se borra nada');
  });

  test('un staff configurado en /config puede pedirlo sin permisos de Discord', async () => {
    store.escribir(GUILD, { modRole: 'rol-mod' });
    const guild = guildFake();
    const canal = canalFake({ mensajes: [{ id: 'm1' }, { id: 'm2' }] });
    const mod = miembroFake('mod-1', { roles: ['rol-mod'] });
    const mensaje = mensajeFake({ guild, canal, miembro: mod });

    await accionesIA.pedirConfirmacion(mensaje, { accion: 'limpiar', cantidad: 100 });
    assert.ok(mensaje.respuestas[0].components?.length, 'el rol de staff de /config alcanza');

    const boton = botonFake({ mensaje, miembro: mod, canal });
    await accionesIA.manejarBoton(boton);
    assert.deepEqual(canal.borrados, ['m1', 'm2'], 'y ejecuta');
  });

  test('una limpieza no lleva más de 100 mensajes por vez (tope de Discord)', async () => {
    store.escribir(GUILD, {});
    const guild = guildFake();
    const canal = canalFake({ mensajes: Array.from({ length: 150 }, (_, i) => ({ id: `m${i}` })) });
    const staff = miembroFake('staff-2', { permisos: [PermissionFlagsBits.ManageMessages] });
    const mensaje = mensajeFake({ guild, canal, miembro: staff });

    // El modelo puede pedir cualquier cosa: la cantidad se acota al ejecutar.
    await accionesIA.pedirConfirmacion(mensaje, { accion: 'limpiar', cantidad: 9999 });
    const boton = botonFake({ mensaje, miembro: staff, canal });
    await accionesIA.manejarBoton(boton);

    assert.deepEqual(canal.limites, [100], 'se piden 100 mensajes, ni uno más');
    assert.equal(canal.borrados.length, 100);
  });

  test('los mensajes de más de 14 días quedan afuera y se avisa', async () => {
    store.escribir(GUILD, {});
    const guild = guildFake();
    const canal = canalFake({
      mensajes: [{ id: 'nuevo-1' }, { id: 'nuevo-2' }, { id: 'viejo-1', antiguedadMs: 20 * DIA_MS }, { id: 'viejo-2', antiguedadMs: 30 * DIA_MS }],
    });
    const staff = miembroFake('staff-3', { permisos: [PermissionFlagsBits.ManageMessages] });
    const mensaje = mensajeFake({ guild, canal, miembro: staff });

    await accionesIA.pedirConfirmacion(mensaje, { accion: 'limpiar', cantidad: 100 });
    const boton = botonFake({ mensaje, miembro: staff, canal });
    await accionesIA.manejarBoton(boton);

    assert.deepEqual(canal.borrados, ['nuevo-1', 'nuevo-2'], 'Discord no borra en bloque los viejos');
    assert.match(textoDe(boton.edits.at(-1)), /2 tenían más de 14 días/);
  });

  test('si solo hay mensajes viejos, se explica en vez de fingir que borró', async () => {
    store.escribir(GUILD, {});
    const guild = guildFake();
    const canal = canalFake({ mensajes: [{ id: 'viejo-1', antiguedadMs: 20 * DIA_MS }] });
    const staff = miembroFake('staff-4', { permisos: [PermissionFlagsBits.ManageMessages] });
    const mensaje = mensajeFake({ guild, canal, miembro: staff });

    await accionesIA.pedirConfirmacion(mensaje, { accion: 'limpiar', cantidad: 100 });
    const boton = botonFake({ mensaje, miembro: staff, canal });
    await accionesIA.manejarBoton(boton);

    assert.deepEqual(canal.borrados, []);
    assert.match(textoDe(boton.edits.at(-1)), /más de 14 días/);
  });

  test('modo lento y bloqueo: se aplican sobre el canal de la orden', async () => {
    store.escribir(GUILD, {});
    const guild = guildFake();
    const canal = canalFake();
    const staff = miembroFake('staff-5', { permisos: [PermissionFlagsBits.ManageChannels] });
    const mensaje = mensajeFake({ guild, canal, miembro: staff });

    await accionesIA.pedirConfirmacion(mensaje, { accion: 'slowmode', segundos: 30, motivo: 'raid' });
    await accionesIA.manejarBoton(botonFake({ mensaje, miembro: staff, canal, customId: 'ia_accion:si' }));
    assert.equal(canal.rateLimitPerUser, 30);

    // Otro moderador: el cooldown de 20 s es por usuario.
    const staff2 = miembroFake('staff-5b', { permisos: [PermissionFlagsBits.ManageChannels] });
    const mensaje2 = mensajeFake({ guild, canal, miembro: staff2 });
    await accionesIA.pedirConfirmacion(mensaje2, { accion: 'bloquear', motivo: 'raid' });
    await accionesIA.manejarBoton(botonFake({ mensaje: mensaje2, miembro: staff2, canal, customId: 'ia_accion:si' }));
    assert.deepEqual(canal.ultimoOverride, { SendMessages: false }, 'cierra el canal para @everyone');
  });

  test('un staff sin el permiso del comando no puede confirmar: la barra es la misma que por comando', async () => {
    store.escribir(GUILD, {});
    const guild = guildFake();
    const canal = canalFake({ mensajes: [{ id: 'm1' }, { id: 'm2' }] });
    // Puede moderar miembros (staff), pero no gestionar mensajes: /clear no lo dejaría.
    // Pide un rol de staff de /config (puede pedir), y confirma otro que solo puede
    // moderar miembros: /clear pide Gestionar mensajes, así que el botón lo rechaza.
    store.escribir(GUILD, { modRole: 'rol-mod' });
    const pide = miembroFake('staff-config-1', { roles: ['rol-mod'] });
    const mensaje = mensajeFake({ guild, canal, miembro: pide });
    await accionesIA.pedirConfirmacion(mensaje, { accion: 'limpiar', cantidad: 100 });
    assert.ok(mensaje.respuestas[0].components?.length, 'el pedido sí se muestra');

    const soloModera = miembroFake('mod-2', { permisos: [PermissionFlagsBits.ModerateMembers] });
    const boton = botonFake({ mensaje, miembro: soloModera, canal });
    await accionesIA.manejarBoton(boton);

    assert.match(textoDe(boton.replies.at(-1)), /Gestionar canales o mensajes/, 'se le dice qué permiso le falta');
    assert.deepEqual(canal.borrados, [], 'y no se borra nada');
  });

  test('cancelar no ejecuta nada', async () => {
    store.escribir(GUILD, {});
    const guild = guildFake();
    const canal = canalFake({ mensajes: [{ id: 'm1' }, { id: 'm2' }] });
    const staff = miembroFake('staff-6', { permisos: [PermissionFlagsBits.ManageMessages] });
    const mensaje = mensajeFake({ guild, canal, miembro: staff });

    await accionesIA.pedirConfirmacion(mensaje, { accion: 'limpiar', cantidad: 100 });
    const boton = botonFake({ mensaje, miembro: staff, canal, customId: 'ia_accion:no' });
    await accionesIA.manejarBoton(boton);

    assert.deepEqual(canal.borrados, []);
    assert.match(textoDe(boton.edits.at(-1)), /cancelada/i);
  });

  test('si Discord rechaza el borrado, se dice el motivo real', async () => {
    store.escribir(GUILD, {});
    const guild = guildFake();
    const canal = canalFake({ mensajes: [{ id: 'm1' }, { id: 'm2' }], fallaBorrado: true });
    const staff = miembroFake('staff-7', { permisos: [PermissionFlagsBits.ManageMessages] });
    const mensaje = mensajeFake({ guild, canal, miembro: staff });

    await accionesIA.pedirConfirmacion(mensaje, { accion: 'limpiar', cantidad: 100 });
    const boton = botonFake({ mensaje, miembro: staff, canal });
    await accionesIA.manejarBoton(boton);

    assert.match(textoDe(boton.edits.at(-1)), /Missing Permissions/, 'nunca se finge un éxito');
  });
});
