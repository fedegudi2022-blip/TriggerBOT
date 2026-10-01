// Tests de la autorización del panel de configuración (Prioridad 1):
// separar la configuración rutinaria (helper/mod/admin) de las secciones
// sensibles —roles de staff, escalada y anti-spam/raid— reservadas al admin.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-config-'));

const store = require('../src/store');
const panel = require('../src/utils/configPanel');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

let contador = 0;

function guildFake({ ownerId = 'dueno-1' } = {}) {
  contador += 1;
  return { id: `g-cfg-${contador}`, name: 'Server', ownerId, channels: { cache: new Map() } };
}

// Interacción fake de componente: `tipo` define qué is*() responde true.
function interaccionFake(
  guild,
  { userId = 'u-1', customId = '', values = [], tipo = 'button', permisos = false, roles = [], fields = null } = {}
) {
  const llamadas = { replies: [], updates: [], modales: 0 };
  const member = {
    id: userId,
    permissions: { has: (p) => permisos && p === PermissionFlagsBits.ManageGuild },
    roles: { cache: { has: (id) => roles.includes(id) } },
  };
  return {
    guild,
    guildId: guild.id,
    user: { id: userId, tag: `${userId}#0001` },
    member,
    customId,
    values,
    fields,
    isButton: () => tipo === 'button',
    isStringSelectMenu: () => tipo === 'select',
    isAnySelectMenu: () => tipo === 'select',
    isModalSubmit: () => tipo === 'modal',
    isFromMessage: () => false,
    async reply(p) {
      llamadas.replies.push(p);
      return p;
    },
    async update(p) {
      llamadas.updates.push(p);
      return p;
    },
    async showModal() {
      llamadas.modales += 1;
    },
    llamadas,
  };
}

const texto = (payload) => {
  const embed = payload.embeds?.[0];
  const data = embed.data ?? embed;
  return [data.title, data.description].filter(Boolean).join('\n');
};

describe('nivelStaff — jerarquía de staff', () => {
  test('dueño, ManageGuild, roles admin/mod/helper o ninguno', () => {
    const guild = guildFake({ ownerId: 'dueno-1' });
    store.escribir(guild.id, { adminRole: 'r-admin', modRole: 'r-mod', helperRole: 'r-helper' });

    assert.equal(panel.nivelStaff(interaccionFake(guild, { userId: 'dueno-1' })), 'admin');
    assert.equal(panel.nivelStaff(interaccionFake(guild, { permisos: true })), 'admin');
    assert.equal(panel.nivelStaff(interaccionFake(guild, { roles: ['r-admin'] })), 'admin');
    assert.equal(panel.nivelStaff(interaccionFake(guild, { roles: ['r-mod'] })), 'mod');
    assert.equal(panel.nivelStaff(interaccionFake(guild, { roles: ['r-helper'] })), 'helper');
    assert.equal(panel.nivelStaff(interaccionFake(guild, { roles: ['r-otro'] })), null);
  });

  test('quien tiene varios roles cuenta como el más alto', () => {
    const guild = guildFake();
    store.escribir(guild.id, { adminRole: 'r-admin', modRole: 'r-mod', helperRole: 'r-helper' });
    assert.equal(panel.nivelStaff(interaccionFake(guild, { roles: ['r-helper', 'r-mod'] })), 'mod');
  });
});

describe('menú y resumen según nivel', () => {
  test('el menú oculta las secciones sensibles a un helper', () => {
    const guild = guildFake();
    store.escribir(guild.id, { adminRole: 'r-admin', helperRole: 'r-helper' });
    const fila = panel.filaMenuPrincipal(interaccionFake(guild, { roles: ['r-helper'] }));
    const valores = fila.components[0].data.options.map((o) => o.value);

    assert.ok(!valores.includes('staff'), 'sin staff');
    assert.ok(!valores.includes('escalada'), 'sin escalada');
    assert.ok(!valores.includes('proteccion'), 'sin protección');
    assert.ok(valores.includes('modlog'), 'mantiene las rutinarias');
  });

  test('el menú incluye todo para un admin', () => {
    const guild = guildFake();
    store.escribir(guild.id, { adminRole: 'r-admin' });
    const fila = panel.filaMenuPrincipal(interaccionFake(guild, { roles: ['r-admin'] }));
    const valores = fila.components[0].data.options.map((o) => o.value);

    for (const s of ['staff', 'escalada', 'proteccion']) assert.ok(valores.includes(s), `incluye ${s}`);
  });

  test('el panel completo no muestra el resumen sensible a un helper', () => {
    const guild = guildFake();
    store.escribir(guild.id, { adminRole: 'r-admin', helperRole: 'r-helper', proteccion: { activado: true } });
    const vista = panel.panelCompleto(interaccionFake(guild, { roles: ['r-helper'] }));
    const nombres = (vista.embeds[0].data.fields ?? []).map((f) => f.name);

    assert.ok(!nombres.includes('Staff del bot'));
    assert.ok(!nombres.includes('Anti-spam/raid'));
    assert.match(texto(vista), /las configura solo un admin/);
  });

  test('un admin sí ve el resumen sensible', () => {
    const guild = guildFake();
    store.escribir(guild.id, { adminRole: 'r-admin', proteccion: { activado: true } });
    const vista = panel.panelCompleto(interaccionFake(guild, { roles: ['r-admin'] }));
    const nombres = (vista.embeds[0].data.fields ?? []).map((f) => f.name);

    assert.ok(nombres.includes('Staff del bot'));
    assert.ok(nombres.includes('Anti-spam/raid'));
  });
});

describe('manejarComponente — revalidación por sección', () => {
  test('un helper no puede asignar roles de staff', async () => {
    const guild = guildFake();
    store.escribir(guild.id, { adminRole: 'r-admin', helperRole: 'r-helper' });
    const ix = interaccionFake(guild, { customId: 'cfg:set:staff:admin', tipo: 'select', values: ['r-nuevo'], roles: ['r-helper'] });

    await panel.manejarComponente(ix);

    assert.equal(ix.llamadas.replies.length, 1);
    assert.match(texto(ix.llamadas.replies[0]), /Solo un admin/);
    assert.equal(store.leer(guild.id).adminRole, 'r-admin', 'no cambió el rol');
    assert.equal(ix.llamadas.updates.length, 0);
  });

  test('un helper no puede apagar la protección', async () => {
    const guild = guildFake();
    store.escribir(guild.id, { helperRole: 'r-helper' });
    const ix = interaccionFake(guild, { customId: 'cfg:toggle:proteccion', roles: ['r-helper'] });

    await panel.manejarComponente(ix);

    assert.match(texto(ix.llamadas.replies[0]), /Solo un admin/);
    assert.equal(store.leer(guild.id).proteccion, undefined);
  });

  test('un helper no puede abrir el modal de la escalada', async () => {
    const guild = guildFake();
    store.escribir(guild.id, { helperRole: 'r-helper' });
    const ix = interaccionFake(guild, { customId: 'cfg:modalpedir:escalada', roles: ['r-helper'] });

    await panel.manejarComponente(ix);

    assert.match(texto(ix.llamadas.replies[0]), /Solo un admin/);
    assert.equal(ix.llamadas.modales, 0);
  });

  test('un helper no puede desactivar la protección', async () => {
    const guild = guildFake();
    store.escribir(guild.id, { helperRole: 'r-helper', proteccion: { activado: true } });
    const ix = interaccionFake(guild, { customId: 'cfg:off:si:proteccion', roles: ['r-helper'] });

    await panel.manejarComponente(ix);

    assert.match(texto(ix.llamadas.replies[0]), /Solo un admin/);
    assert.ok(store.leer(guild.id).proteccion, 'la protección sigue configurada');
  });

  test('un helper SÍ configura canales rutinarios', async () => {
    const guild = guildFake();
    store.escribir(guild.id, { helperRole: 'r-helper' });
    const ix = interaccionFake(guild, { customId: 'cfg:set:modlog:canal', tipo: 'select', values: ['canal-9'], roles: ['r-helper'] });

    await panel.manejarComponente(ix);

    assert.equal(store.leer(guild.id).modlog, 'canal-9');
    assert.equal(ix.llamadas.updates.length, 1);
    assert.equal(ix.llamadas.replies.length, 0);
  });

  test('un admin SÍ puede asignar roles de staff', async () => {
    const guild = guildFake();
    store.escribir(guild.id, { adminRole: 'r-admin' });
    const ix = interaccionFake(guild, { customId: 'cfg:set:staff:admin', tipo: 'select', values: ['r-nuevo'], roles: ['r-admin'] });

    await panel.manejarComponente(ix);

    assert.equal(store.leer(guild.id).adminRole, 'r-nuevo');
    assert.equal(ix.llamadas.updates.length, 1);
  });

  test('un miembro común no entra al panel', async () => {
    const guild = guildFake();
    store.escribir(guild.id, {});
    const ix = interaccionFake(guild, { customId: 'cfg:set:modlog:canal', tipo: 'select', values: ['canal-9'] });

    await panel.manejarComponente(ix);

    assert.match(texto(ix.llamadas.replies[0]), /Solo el staff/);
    assert.equal(store.leer(guild.id).modlog, undefined);
  });
});

describe('vistaSeccion — defensa en profundidad', () => {
  test('un helper no ve la sección de staff ni con customId fabricado', () => {
    const guild = guildFake();
    store.escribir(guild.id, { adminRole: 'r-admin', helperRole: 'r-helper' });
    const vista = panel.vistaSeccion(interaccionFake(guild, { roles: ['r-helper'] }), 'staff');

    assert.match(texto(vista), /Solo un admin/);
  });

  test('un admin sí ve la sección de staff', () => {
    const guild = guildFake();
    store.escribir(guild.id, { adminRole: 'r-admin', staffRole: 'r-staff' });
    const vista = panel.vistaSeccion(interaccionFake(guild, { roles: ['r-admin'] }), 'staff');

    assert.doesNotMatch(texto(vista), /Solo un admin/);
  });
});
