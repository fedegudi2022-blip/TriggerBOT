// Tests de la autorización de staff unificada (src/utils/permisos.js).
//
// Es la fuente de verdad de "quién es staff" para TODO el bot: reemplaza los
// chequeos sueltos que antes repetía cada comando y hace que la política interna
// (dueño, ManageGuild o roles admin/mod/helper de /config) sea la misma en todos.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-permisos-'));

const store = require('../src/store');
const permisos = require('../src/utils/permisos');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

let contador = 0;

function guildFake({ ownerId = 'dueno-1' } = {}) {
  contador += 1;
  return { id: `g-perm-${contador}`, name: 'Server', ownerId };
}

function miembroFake(id, { permisosNativos = [], roles = [] } = {}) {
  return {
    id,
    permissions: { has: (p) => permisosNativos.includes(p) },
    roles: { cache: { has: (idRol) => roles.includes(idRol) } },
  };
}

function interaccionFake(guild, member) {
  const replies = [];
  return {
    guild,
    guildId: guild.id,
    member,
    replies,
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
  };
}

describe('nivelDe — jerarquía de staff', () => {
  test('el dueño del servidor es admin', () => {
    const g = guildFake({ ownerId: 'dueno-1' });
    store.escribir(g.id, {});
    assert.equal(permisos.nivelDe(g, miembroFake('dueno-1')), 'admin');
  });

  test('ManageGuild es admin aunque no tenga rol configurado', () => {
    const g = guildFake();
    store.escribir(g.id, {});
    assert.equal(permisos.nivelDe(g, miembroFake('u', { permisosNativos: [PermissionFlagsBits.ManageGuild] })), 'admin');
  });

  test('los roles configurados dan su nivel y ninguno da null', () => {
    const g = guildFake();
    store.escribir(g.id, { adminRole: 'r-admin', modRole: 'r-mod', helperRole: 'r-helper' });
    assert.equal(permisos.nivelDe(g, miembroFake('u', { roles: ['r-admin'] })), 'admin');
    assert.equal(permisos.nivelDe(g, miembroFake('u', { roles: ['r-mod'] })), 'mod');
    assert.equal(permisos.nivelDe(g, miembroFake('u', { roles: ['r-helper'] })), 'helper');
    assert.equal(permisos.nivelDe(g, miembroFake('u', { roles: ['r-otro'] })), null);
  });

  test('quien tiene varios roles cuenta como el más alto', () => {
    const g = guildFake();
    store.escribir(g.id, { modRole: 'r-mod', helperRole: 'r-helper' });
    assert.equal(permisos.nivelDe(g, miembroFake('u', { roles: ['r-helper', 'r-mod'] })), 'mod');
  });

  test('sin miembro devuelve null', () => {
    assert.equal(permisos.nivelDe(guildFake(), null), null);
  });
});

describe('autorizado — roles configurados O permiso nativo', () => {
  test('un helper configurado por rol habilita aunque no tenga el permiso nativo', () => {
    // El caso que motivó la Prioridad 2: Discord ocultaba el comando a un helper
    // por rol; la política interna ahora lo acepta igual.
    const g = guildFake();
    store.escribir(g.id, { helperRole: 'r-helper' });
    const ix = interaccionFake(g, miembroFake('u', { roles: ['r-helper'] }));
    assert.equal(permisos.autorizado(ix, PermissionFlagsBits.ModerateMembers), true);
  });

  test('el permiso nativo queda como respaldo', () => {
    const g = guildFake();
    store.escribir(g.id, {});
    const ix = interaccionFake(g, miembroFake('u', { permisosNativos: [PermissionFlagsBits.BanMembers] }));
    assert.equal(permisos.autorizado(ix, PermissionFlagsBits.BanMembers), true);
  });

  test('sin staff ni permiso nativo queda afuera', () => {
    const g = guildFake();
    store.escribir(g.id, {});
    const ix = interaccionFake(g, miembroFake('u'));
    assert.equal(permisos.autorizado(ix, PermissionFlagsBits.BanMembers), false);
  });

  test('autorizadoDe es la variante sin interacción', () => {
    const g = guildFake();
    store.escribir(g.id, { modRole: 'r-mod' });
    assert.equal(permisos.autorizadoDe(g, miembroFake('u', { roles: ['r-mod'] })), true);
    assert.equal(permisos.autorizadoDe(g, miembroFake('u')), false);
  });
});

describe('esStaff / esAdmin / esStaffDe', () => {
  test('esStaff es true con cualquier nivel y false sin ninguno', () => {
    const g = guildFake();
    store.escribir(g.id, { helperRole: 'r-helper' });
    assert.equal(permisos.esStaff(interaccionFake(g, miembroFake('u', { roles: ['r-helper'] }))), true);
    assert.equal(permisos.esStaff(interaccionFake(g, miembroFake('u'))), false);
  });

  test('esAdmin solo con nivel admin', () => {
    const g = guildFake();
    store.escribir(g.id, { modRole: 'r-mod' });
    assert.equal(permisos.esAdmin(interaccionFake(g, miembroFake('u', { roles: ['r-mod'] }))), false);
    assert.equal(
      permisos.esAdmin(interaccionFake(g, miembroFake('u', { permisosNativos: [PermissionFlagsBits.ManageGuild] }))),
      true
    );
  });

  test('esStaffDe es la variante sin interacción', () => {
    const g = guildFake();
    store.escribir(g.id, { helperRole: 'r-helper' });
    assert.equal(permisos.esStaffDe(g, miembroFake('u', { roles: ['r-helper'] })), true);
    assert.equal(permisos.esStaffDe(g, miembroFake('u')), false);
  });
});

describe('exigirStaff — guard de comando', () => {
  test('deja pasar al staff sin responder', async () => {
    const g = guildFake();
    store.escribir(g.id, { helperRole: 'r-helper' });
    const ix = interaccionFake(g, miembroFake('u', { roles: ['r-helper'] }));

    assert.equal(await permisos.exigirStaff(ix, PermissionFlagsBits.ModerateMembers), true);
    assert.equal(ix.replies.length, 0, 'no responde nada cuando autoriza');
  });

  test('responde efímero y devuelve false al no autorizado', async () => {
    const g = guildFake();
    store.escribir(g.id, {});
    const ix = interaccionFake(g, miembroFake('u'));

    assert.equal(await permisos.exigirStaff(ix, PermissionFlagsBits.ModerateMembers), false);
    assert.equal(ix.replies.length, 1);
    assert.equal(ix.replies[0].flags, 64, 'la respuesta es efímera');
    assert.match(JSON.stringify(ix.replies[0]), /Solo staff/);
  });
});
