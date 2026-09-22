// Tests de src/utils/proteccion.js — detección de spam/raid y acciones con resultado real.
// Sin Supabase configurado: la capa de sync queda en no-op y nada toca la red.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-proteccion-'));

const store = require('../src/store');
const proteccion = require('../src/utils/proteccion');

// ---------- Fábricas ----------
function guildFake(id, { permisosBot = [], muteRole = null } = {}) {
  const guild = {
    id,
    ownerId: `owner-${id}`,
    members: {
      me: {
        id: 'bot-1',
        roles: { highest: { position: 100 } },
        permissions: { has: (p) => permisosBot.includes(p) },
      },
      cache: new Map(),
    },
    channels: { cache: new Map() }, // sin canales: alertas y modlog quedan en no-op
    roles: { cache: new Map(muteRole ? [[muteRole, { id: muteRole }]] : []) },
    client: { user: { id: 'bot-1' } },
  };
  return guild;
}

function miembroFake(id, guild, { posicionRol = 1, creado = Date.now(), rolesCacheSize = 1, fallaTimeout = null } = {}) {
  return {
    id,
    guild,
    user: { id, tag: `usuario-${id}`, bot: false, createdTimestamp: creado, send: async () => {} },
    permissions: { has: () => false },
    roles: {
      highest: { position: posicionRol },
      cache: { size: rolesCacheSize },
      add: async () => {},
    },
    timeout: async () => {
      if (fallaTimeout) throw fallaTimeout;
    },
    kick: async () => {},
    ban: async () => {},
  };
}

function mensajeFake(id, guild, member) {
  return { id, guildId: guild.id, channelId: 'canal-1', guild, member, author: member.user };
}

function activar(guildId, extras = {}) {
  store.setGuildConfig(guildId, (c) => {
    c.proteccion = { activado: true, ...extras };
  });
}

beforeEach(() => proteccion.resetear());

// ---------- Anti-spam ----------
describe('procesarMensajeParaSpam', () => {
  test('no actúa si la protección está desactivada', async () => {
    const guild = guildFake('g-spam-off');
    const member = miembroFake('u-1', guild);
    store.setGuildConfig(guild.id, (c) => { c.proteccion = { activado: false }; });
    for (let i = 0; i < 6; i++) {
      const r = await proteccion.procesarMensajeParaSpam(mensajeFake(`m${i}`, guild, member));
      assert.equal(r, false);
    }
  });

  test('exime al staff con permiso de gestionar mensajes', async () => {
    const guild = guildFake('g-spam-staff');
    activar(guild.id, { spamMensajes: 3, spamSegundos: 10 });
    const staff = miembroFake('staff-1', guild);
    staff.permissions.has = (p) => p === PermissionFlagsBits.ManageMessages;
    for (let i = 0; i < 6; i++) {
      const r = await proteccion.procesarMensajeParaSpam(mensajeFake(`m${i}`, guild, staff));
      assert.equal(r, false);
    }
  });

  test('detecta el flood y actúa (acción "aviso")', async () => {
    const guild = guildFake('g-spam-on');
    activar(guild.id, { accionSpam: 'aviso', spamMensajes: 3, spamSegundos: 10 });
    const member = miembroFake('u-2', guild);

    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m1', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m2', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m3', guild, member)), true);
  });

  test('respeta la ventana de segundos (mensajes lentos no son spam)', async () => {
    const guild = guildFake('g-spam-ventana');
    activar(guild.id, { accionSpam: 'aviso', spamMensajes: 3, spamSegundos: 2 });
    const member = miembroFake('u-3', guild);

    const t = Date.now();
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m1', guild, member)), false);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m2', guild, member)), false);
    await new Promise((r) => setTimeout(r, 2100)); // el 1er y 2do mensaje ya salieron de la ventana
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m3', guild, member)), false);
  });

  test('no castiga dos veces al mismo usuario dentro del cooldown', async () => {
    const guild = guildFake('g-spam-cooldown');
    activar(guild.id, { accionSpam: 'aviso', spamMensajes: 3, spamSegundos: 60 });
    const member = miembroFake('u-4', guild);

    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m1', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m2', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m3', guild, member)), true, 'el 3er mensaje cruza el umbral y castiga');
    // Dentro del cooldown de 30 s no vuelve a castigar aunque siga superando el umbral.
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m4', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m5', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m6', guild, member)), false);
  });
});

// ---------- Acciones con resultado real ----------
describe('ejecutarAccion y aplicarMute', () => {
  test('timeout exitoso reporta el resultado real', async () => {
    const guild = guildFake('g-acc-1', { permisosBot: [PermissionFlagsBits.ModerateMembers] });
    const member = miembroFake('u-1', guild);
    const texto = await proteccion.ejecutarAccion(member, 'timeout', 'razón', 'spam');
    assert.equal(texto, 'timeout de 10 min');
  });

  test('timeout rechazado por permisos NO miente sobre el resultado', async () => {
    const guild = guildFake('g-acc-2', { permisosBot: [] }); // bot sin ModerateMembers
    const member = miembroFake('u-1', guild);
    const texto = await proteccion.ejecutarAccion(member, 'timeout', 'razón', 'spam');
    assert.match(texto, /⚠️ timeout falló: Me falta el permiso/);
  });

  test('baneo rechazado por Discord reporta el error concreto', async () => {
    const guild = guildFake('g-acc-3', { permisosBot: [PermissionFlagsBits.BanMembers] });
    const member = miembroFake('u-1', guild);
    member.ban = async () => { throw new Error('falta jerarquía'); };
    const texto = await proteccion.ejecutarAccion(member, 'ban', 'razón', 'spam');
    assert.match(texto, /⚠️ Discord rechazó el baneo: falta jerarquía/);
  });

  test('aplicarMute con rol configurado: asigna el rol de verdad', async () => {
    const guild = guildFake('g-acc-4', { permisosBot: [PermissionFlagsBits.ManageRoles], muteRole: 'rol-mute' });
    store.setGuildConfig(guild.id, (c) => { c.muteRole = 'rol-mute'; }); // el rol viene de la config del server
    const member = miembroFake('u-1', guild);
    let rolAsignado = false;
    member.roles.add = async () => { rolAsignado = true; };
    const res = await proteccion.aplicarMute(member, 'razón');
    assert.deepEqual(res, { ok: true, fallback: false });
    assert.equal(rolAsignado, true);
  });

  test('aplicarMute sin rol configurado: aplica timeout REAL como fallback', async () => {
    const guild = guildFake('g-acc-5', { permisosBot: [PermissionFlagsBits.ModerateMembers] });
    const member = miembroFake('u-1', guild);
    let timeoutAplicado = false;
    member.timeout = async () => { timeoutAplicado = true; };
    const res = await proteccion.aplicarMute(member, 'razón');
    assert.deepEqual(res, { ok: true, fallback: true });
    assert.equal(timeoutAplicado, true, 'el fallback debe EJECUTAR el timeout, no solo anunciarlo');
  });

  test('aplicarMute sin rol y sin permiso de timeout: falla honestamente', async () => {
    const guild = guildFake('g-acc-6', { permisosBot: [] });
    const member = miembroFake('u-1', guild);
    const res = await proteccion.aplicarMute(member, 'razón');
    assert.equal(res.ok, false);
    assert.match(res.error, /Me falta el permiso/);
  });
});

// ---------- Anti-raid ----------
describe('registrarIngreso (anti-raid)', () => {
  test('auto-acción solo sobre cuentas nuevas sin roles; el resto queda a salvo', async () => {
    const guild = guildFake('g-raid-1', { permisosBot: [PermissionFlagsBits.KickMembers] });
    store.setGuildConfig(guild.id, (c) => {
      c.proteccion = { activado: true, raidJoins: 5, raidSegundos: 60, accionesRapidas: true, accionRaid: 'kick' };
    });

    let expulsados = 0;
    const hacerMiembro = (id, { viejo = false, conRoles = false, bot = false } = {}) => {
      const m = miembroFake(id, guild, {
        creado: viejo ? Date.now() - 30 * 86400_000 : Date.now(),
        rolesCacheSize: conRoles ? 3 : 1,
      });
      m.user.bot = bot;
      m.kick = async () => { expulsados += 1; };
      guild.members.cache.set(id, m);
      return m;
    };

    // Mezcla: 2 cuentas nuevas calificadas + bot + cuenta con roles ya asignados.
    await proteccion.registrarIngreso(hacerMiembro('nuevo-A'));
    await proteccion.registrarIngreso(hacerMiembro('nuevo-B'));
    await proteccion.registrarIngreso(hacerMiembro('bot-raid', { bot: true }));
    await proteccion.registrarIngreso(hacerMiembro('con-roles', { conRoles: true }));
    assert.equal(expulsados, 0, 'no actúa antes de alcanzar el umbral de ingresos');

    // El 5º ingreso cruza el umbral: la oleada entera se evalúa de una vez.
    await proteccion.registrarIngreso(hacerMiembro('nuevo-C'));
    assert.equal(expulsados, 3, 'solo las 3 cuentas nuevas sin roles fueron expulsadas');

    // Los que no calificaron siguen en el servidor.
    assert.ok(guild.members.cache.has('bot-raid'));
    assert.ok(guild.members.cache.has('con-roles'));
  });

  test('con auto-acción apagada: alerta sin expulsar a nadie', async () => {
    const guild = guildFake('g-raid-2', { permisosBot: [PermissionFlagsBits.KickMembers] });
    store.setGuildConfig(guild.id, (c) => {
      c.proteccion = { activado: true, raidJoins: 2, raidSegundos: 60, accionesRapidas: false, accionRaid: 'kick' };
    });

    let expulsados = 0;
    const hacerMiembro = (id) => {
      const m = miembroFake(id, guild);
      m.kick = async () => { expulsados += 1; };
      guild.members.cache.set(id, m);
      return m;
    };

    await proteccion.registrarIngreso(hacerMiembro('n-1'));
    await proteccion.registrarIngreso(hacerMiembro('n-2'));
    await proteccion.registrarIngreso(hacerMiembro('n-3'));
    assert.equal(expulsados, 0);
  });
});
