// Tests de los tipos de ticket, el reclamo, sumar gente y la calificación del cierre.
// Complementa tests/tickets.test.js (transcripts y cierre seguro). Fakes literales,
// sin red: cada test usa su propio guild para no pisarse la config.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-ticket-tipos-'));

const tickets = require('../src/utils/tickets');
const store = require('../src/store');
const reportar = require('../src/commands/reportar');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

// ---------- Fakes ----------
let contador = 0;

// Discord usa Collections (Map + helpers). El código toca .find() y .last().
function coleccion(items = []) {
  const map = new Map(items);
  map.last = () => [...map.values()][map.size - 1];
  map.find = (fn) => [...map.values()].find(fn);
  return map;
}

function guildFake() {
  contador += 1;
  const id = `g-tipos-${contador}`;
  const guild = {
    id,
    name: 'Server de prueba',
    ownerId: `${id}-dueno`,
    roles: { cache: new Map(), everyone: { id: 'rol-everyone' } },
    channels: { cache: coleccion(), create: null },
    members: { cache: coleccion(), me: { id: 'bot-1', permissions: { has: () => true } }, fetch: async () => null },
    client: { user: { id: 'bot-1' }, users: { fetch: async () => ({ send: async () => ({ id: 'dm' }) }) } },
  };
  guild.creados = [];
  guild.channels.create = async (opciones) => {
    const canal = canalBase({ guild, topic: opciones.topic, name: opciones.name });
    guild.creados.push({ opciones, canal });
    return canal;
  };
  return guild;
}

// Canal de ticket con lo mínimo que toca el módulo.
function canalBase({ guild, topic, name = 'soporte-001' }) {
  const canal = {
    id: `canal-${contador}-${guild.channels.cache.size + 1}`,
    name,
    topic,
    enviados: [],
    deleted: false,
    attachments: new Map(),
    permissionOverwrites: { edit: async () => {} },
    messages: {
      fetch: async () =>
        coleccion([
          ['m1', { id: 'm1', createdTimestamp: Date.now() - 60_000, author: { username: 'fede' }, content: 'hola', attachments: new Map() }],
        ]),
    },
  };
  canal.send = async (payload) => {
    canal.enviados.push(payload);
    return { id: `msg-${canal.enviados.length}` };
  };
  canal.delete = async () => {
    canal.deleted = true;
  };
  canal.guild = guild;
  guild.channels.cache.set(canal.id, canal);
  return canal;
}

function miembroFake(guild, id, { staff = false } = {}) {
  const member = {
    id,
    guild,
    user: { id, username: `usuario-${id}`, tag: `${id}#0001` },
    permissions: { has: (p) => staff && p === PermissionFlagsBits.ManageGuild },
    roles: { cache: { has: () => false }, highest: { position: 5 } },
  };
  guild.members.cache.set(id, member);
  guild.members.fetch = async (userId) => guild.members.cache.get(userId) ?? null;
  return member;
}

function interaccionFake(canal, { customId = 'ticket:reclamar', user = null, member = null, values = [], fields = null, tipo = 'button' } = {}) {
  const llamadas = { replies: [], updates: [], modales: [] };
  return {
    channel: canal,
    guild: canal.guild,
    guildId: canal.guild.id,
    client: { user: { id: 'bot-1' }, guilds: { cache: new Map([[canal.guild.id, canal.guild]]) } },
    user: user ?? { id: 'user-1', username: 'fede', tag: 'fede#0001' },
    member,
    customId,
    values,
    fields,
    isButton: () => tipo === 'button',
    isStringSelectMenu: () => tipo === 'select',
    isModalSubmit: () => tipo === 'modal',
    async reply(payload) {
      llamadas.replies.push(payload);
      return payload;
    },
    async update(payload) {
      llamadas.updates.push(payload);
      return payload;
    },
    async showModal(modal) {
      llamadas.modales.push(modal);
      return modal;
    },
    async deferReply(payload) {
      llamadas.defers = (llamadas.defers ?? []).concat(payload);
    },
    async editReply(payload) {
      llamadas.replies.push(payload);
      return payload;
    },
    llamadas,
  };
}

const textosDelCanal = (canal) =>
  canal.enviados.map((p) => (p.embeds ?? []).map((e) => `${e.data?.title ?? ''} ${e.data?.description ?? ''}`).join(' ')).join(' | ');

// ---------- Panel y formularios ----------
describe('panel con tipos de ticket', () => {
  test('ofrece soporte, apelación y reporte en un selector', () => {
    const guild = guildFake();
    store.escribir(guild.id, {});
    const vista = tickets.panel(guild);
    const select = vista.components[0].toJSON().components[0];

    assert.equal(select.custom_id, 'ticket:sel:tipo');
    assert.deepEqual(
      select.options.map((o) => o.value),
      ['soporte', 'apelacion', 'reporte']
    );
  });

  test('elegir un tipo abre el formulario de ESE tipo', async () => {
    const guild = guildFake();
    const canal = canalBase({ guild, topic: `${guild.id}:user-1:001:soporte` });
    const ix = interaccionFake(canal, { customId: 'ticket:sel:tipo', tipo: 'select', values: ['apelacion'] });

    await tickets.manejarSelectTicket(ix);

    const modal = ix.llamadas.modales[0].toJSON();
    assert.equal(modal.custom_id, 'ticket:modal:apelacion');
    assert.deepEqual(
      modal.components.map((f) => f.components[0].custom_id),
      ['sancion', 'motivo']
    );
  });

  test('el reporte pide a quién y con qué pruebas', async () => {
    const guild = guildFake();
    const canal = canalBase({ guild, topic: `${guild.id}:user-1:001:soporte` });
    const ix = interaccionFake(canal, { customId: 'ticket:sel:tipo', tipo: 'select', values: ['reporte'] });

    await tickets.manejarSelectTicket(ix);

    const modal = ix.llamadas.modales[0].toJSON();
    assert.equal(modal.custom_id, 'ticket:modal:reporte');
    assert.deepEqual(
      modal.components.map((f) => f.components[0].custom_id),
      ['reportado', 'pruebas', 'adjunto']
    );
    // El link a las pruebas es opcional; el resto, obligatorio.
    assert.equal(modal.components[2].components[0].required, false);
    assert.equal(modal.components[1].components[0].required, true);
  });
});

describe('abrirTicket por tipo', () => {
  test('crea el canal con el prefijo y el topic del tipo, y anota el ticket activo', async () => {
    const guild = guildFake();
    const miembro = miembroFake(guild, 'user-7');
    const ix = interaccionFake(canalBase({ guild, topic: '' }), { user: miembro.user, member: miembro });

    const resultado = await tickets.abrirTicket(ix, {
      tipo: 'reporte',
      campos: { reportado: 'cheater (999)', pruebas: 'aimbot en dust2' },
    });

    assert.ok(resultado.canal, 'devolvió el canal creado');
    const { opciones, canal } = guild.creados[0];
    assert.match(opciones.name, /^reporte-\d{3}$/);
    assert.match(opciones.topic, new RegExp(`^${guild.id}:user-7:\\d{3}:reporte$`));

    const embed = canal.enviados[0].embeds[0].data;
    assert.match(embed.title, /Reporte de cheater/);
    assert.match(embed.description, /aimbot en dust2/);
    const botones = canal.enviados[0].components[0].toJSON().components.map((b) => b.custom_id);
    assert.deepEqual(botones, ['ticket:reclamar', 'ticket:agregar', 'ticket:cerrar']);

    const activo = tickets.activoDe(guild.id, canal.id);
    assert.equal(activo.tipo, 'reporte');
    assert.equal(activo.userId, 'user-7');
    assert.equal(activo.numero, opciones.topic.split(':')[2]);
  });

  test('un tipo desconocido cae en soporte (no rompe el panel viejo)', async () => {
    const guild = guildFake();
    const miembro = miembroFake(guild, 'user-8');
    const ix = interaccionFake(canalBase({ guild, topic: '' }), { user: miembro.user, member: miembro });

    await tickets.abrirTicket(ix, { tipo: 'loquesea', campos: { motivo: 'ayuda' } });

    assert.match(guild.creados[0].opciones.name, /^soporte-\d{3}$/);
  });

  test('no deja abrir dos tickets a la misma persona', async () => {
    const guild = guildFake();
    canalBase({ guild, topic: `${guild.id}:user-7:001:soporte` });
    const miembro = miembroFake(guild, 'user-7');
    const ix = interaccionFake(canalBase({ guild, topic: '' }), { user: miembro.user, member: miembro });

    const resultado = await tickets.abrirTicket(ix, { tipo: 'soporte', campos: {} });

    assert.match(resultado.error, /Ya tenés un ticket abierto/);
    assert.equal(guild.creados.length, 0, 'no creó un segundo canal');
  });
});

// ---------- Reclamo ----------
describe('reclamar el ticket', () => {
  test('el primer staff que reclama deja el ticket a su nombre', async () => {
    const guild = guildFake();
    const canal = canalBase({ guild, topic: `${guild.id}:user-1:001:soporte` });
    const staff = miembroFake(guild, 'staff-1', { staff: true });

    await tickets.manejarBotonTicket(interaccionFake(canal, { member: staff, user: staff.user }));

    assert.equal(tickets.activoDe(guild.id, canal.id).reclamadoPor, 'staff-1');
    assert.match(textosDelCanal(canal), /Ticket reclamado/);
  });

  test('un segundo staff no puede pisar el reclamo', async () => {
    const guild = guildFake();
    const canal = canalBase({ guild, topic: `${guild.id}:user-1:001:soporte` });
    store.escribir(guild.id, { tickets: { activos: { [canal.id]: { numero: '001', tipo: 'soporte', reclamadoPor: 'staff-1' } } } });
    const otro = miembroFake(guild, 'staff-2', { staff: true });
    const ix = interaccionFake(canal, { member: otro, user: otro.user });

    await tickets.manejarBotonTicket(ix);

    assert.match(ix.llamadas.replies[0].content, /ya lo está atendiendo <@staff-1>/);
    assert.equal(tickets.activoDe(guild.id, canal.id).reclamadoPor, 'staff-1');
  });

  test('un miembro común no puede reclamar', async () => {
    const guild = guildFake();
    const canal = canalBase({ guild, topic: `${guild.id}:user-1:001:soporte` });
    const comun = miembroFake(guild, 'comun-1');
    const ix = interaccionFake(canal, { member: comun, user: comun.user });

    await tickets.manejarBotonTicket(ix);

    assert.match(ix.llamadas.replies[0].content, /Solo el staff/);
    assert.equal(tickets.activoDe(guild.id, canal.id), null);
  });
});

// ---------- Agregar gente ----------
describe('agregar usuario al ticket', () => {
  test('acepta una mención y le da acceso al canal', async () => {
    const guild = guildFake();
    const canal = canalBase({ guild, topic: `${guild.id}:user-1:001:soporte` });
    const permisos = [];
    canal.permissionOverwrites = { edit: async (id, perm) => permisos.push({ id, perm }) };
    const invitado = miembroFake(guild, '555555555555555555');
    const staff = miembroFake(guild, 'staff-1', { staff: true });
    const ix = interaccionFake(canal, {
      customId: 'ticket:modal:agregar',
      tipo: 'modal',
      member: staff,
      user: staff.user,
      fields: { getTextInputValue: () => '@invitado <@555555555555555555>' },
    });

    await tickets.manejarModalTicket(ix);

    assert.deepEqual(permisos, [
      {
        id: '555555555555555555',
        perm: { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true },
      },
    ]);
    assert.match(textosDelCanal(canal), /Usuario agregado/);
    assert.match(ix.llamadas.replies[0].content, /usuario-555555555555555555/);
    assert.equal(invitado.id, '555555555555555555');
  });

  test('sin una ID válida avisa y no toca permisos', async () => {
    const guild = guildFake();
    const canal = canalBase({ guild, topic: `${guild.id}:user-1:001:soporte` });
    let tocoPermisos = false;
    canal.permissionOverwrites = { edit: async () => (tocoPermisos = true) };
    const staff = miembroFake(guild, 'staff-1', { staff: true });
    const ix = interaccionFake(canal, {
      customId: 'ticket:modal:agregar',
      tipo: 'modal',
      member: staff,
      user: staff.user,
      fields: { getTextInputValue: () => 'mi amigo fede' },
    });

    await tickets.manejarModalTicket(ix);

    assert.equal(tocoPermisos, false);
    assert.match(ix.llamadas.replies[0].content, /No encontré una ID válida/);
  });
});

// ---------- Cierre y calificación ----------
describe('cierre con resumen y calificación', () => {
  function cierreListo() {
    const guild = guildFake();
    const logs = { id: 'canal-logs', enviados: [], send: async (p) => { logs.enviados.push(p); return { id: 'l' }; } };
    guild.channels.cache.set(logs.id, logs);
    const canal = canalBase({ guild, topic: `${guild.id}:user-1:007:apelacion`, name: 'apelacion-007' });
    const dms = [];
    guild.client.users.fetch = async () => ({ send: async (p) => { dms.push(p); return { id: 'dm' }; } });
    store.escribir(guild.id, {
      tickets: {
        canalLogs: logs.id,
        activos: { [canal.id]: { numero: '007', userId: 'user-1', tipo: 'apelacion', ts: Date.now() - 90_000, reclamadoPor: 'staff-1' } },
      },
    });
    const staff = miembroFake(guild, 'staff-1', { staff: true });
    return { guild, canal, logs, dms, staff };
  }

  test('deja el resumen completo, pide la encuesta y limpia el ticket activo', async () => {
    const { guild, canal, dms, staff } = cierreListo();

    await tickets.cerrarTicket({ channel: canal }, staff.user, { graciaMs: 0 });

    assert.equal(canal.deleted, true, 'con el transcript a salvo el canal se borra');
    const resumen = textosDelCanal(canal);
    assert.match(resumen, /\*\*Tipo:\*\* Apelación/);
    assert.match(resumen, /\*\*Atendido por:\*\* <@staff-1>/);
    assert.match(resumen, /\*\*Cerrado por:\*\* usuario-staff-1/);
    assert.match(resumen, /\*\*Duración:\*\* 1 min/);
    assert.equal(tickets.activoDe(guild.id, canal.id), null, 'el ticket activo se limpia al cerrar');

    const encuesta = dms.at(-1);
    const botones = encuesta.components[0].toJSON().components;
    assert.equal(botones.length, 5);
    assert.deepEqual(
      botones.map((b) => b.label),
      ['1/5', '2/5', '3/5', '4/5', '5/5']
    );
    assert.equal(botones[0].custom_id, `ticket:calificar:${guild.id}:1`);
    assert.equal(tickets.encuestaPendienteDe(guild.id, 'user-1').numero, '007');
  });

  test('calificar guarda el valor, limpia el pendiente y avisa al staff con el promedio', async () => {
    const { guild, logs } = cierreListo();
    const canalCalificado = canalBase({ guild, topic: `${guild.id}:user-1:008:soporte` });
    store.setGuildConfig(guild.id, (c) => {
      c.tickets.encuestas = { 'user-1': { numero: '008', staffId: 'staff-1' } };
    });

    const ix = interaccionFake(canalCalificado, { customId: `ticket:calificar:${guild.id}:4`, user: { id: 'user-1', username: 'fede' } });
    ix.guild = null; // es un DM: la interacción no trae guild

    await tickets.manejarBotonTicket(ix);

    const guardadas = store.leer(guild.id).tickets.calificaciones;
    assert.equal(guardadas.length, 1);
    assert.deepEqual({ valor: guardadas[0].valor, staffId: guardadas[0].staffId, numero: guardadas[0].numero }, { valor: 4, staffId: 'staff-1', numero: '008' });
    assert.equal(tickets.encuestaPendienteDe(guild.id, 'user-1'), null, 'el pendiente se limpia');
    assert.match(ix.llamadas.updates[0].content, /4\/5/);

    const aviso = logs.enviados.at(-1).embeds[0].data;
    assert.match(aviso.title, /calificado con 4\/5/);
    assert.match(aviso.description, /\*\*Promedio:\*\* 4\.0\/5/);
    assert.equal(store.leer(guild.id).tickets.encuestas, undefined, 'sin encuestas pendientes no queda la clave');
  });

  test('no se puede calificar dos veces el mismo cierre', async () => {
    const guild = guildFake();
    store.escribir(guild.id, { tickets: {} });
    const canal = canalBase({ guild, topic: `${guild.id}:user-1:009:soporte` });
    const ix = interaccionFake(canal, { customId: `ticket:calificar:${guild.id}:5`, user: { id: 'user-1' } });

    await tickets.manejarBotonTicket(ix);

    assert.match(ix.llamadas.replies[0].content, /ya está respondida/);
    assert.equal(store.leer(guild.id).tickets.calificaciones, undefined);
  });
});

// ---------- /reportar (cualquier miembro, sin pasar por el panel) ----------
describe('/reportar', () => {
  function comandoFake({ guild, user = { id: 'user-9', username: 'fede' }, opciones = {} }) {
    const llamadas = { defers: [], edits: [] };
    return {
      guild,
      guildId: guild.id,
      user,
      client: { user: { id: 'bot-1' } },
      options: {
        getUser: (n) => opciones[n] ?? null,
        getString: (n) => opciones[n] ?? null,
        getBoolean: (n) => opciones[n] ?? null,
      },
      async deferReply(payload) {
        llamadas.defers.push(payload);
      },
      async editReply(payload) {
        llamadas.edits.push(payload);
        return payload;
      },
      llamadas,
    };
  }

  test('abre un ticket de reporte con las pruebas cargadas', async () => {
    const guild = guildFake();
    const ix = comandoFake({
      guild,
      opciones: { usuario: { id: '999', username: 'cheater', bot: false }, pruebas: 'aimbot en dust2, minuto 3', adjunto: 'https://youtu.be/prueba' },
    });

    await reportar.execute(ix);

    assert.equal(guild.creados.length, 1, 'abrió un solo ticket');
    assert.match(guild.creados[0].opciones.name, /^reporte-\d{3}$/);
    const embed = guild.creados[0].canal.enviados[0].embeds[0].data;
    assert.match(embed.title, /Reporte de cheater/);
    assert.match(embed.description, /cheater \(999\)/);
    assert.match(embed.description, /aimbot en dust2/);
    assert.match(embed.description, /https:\/\/youtu\.be\/prueba/);
    assert.match(ix.llamadas.edits.at(-1).content, /Ticket #\d{3}/);
  });

  test('sin link de pruebas aclara que el staff las va a pedir en el ticket', async () => {
    const guild = guildFake();
    const ix = comandoFake({ guild, opciones: { usuario: { id: '999', username: 'cheater', bot: false }, pruebas: 'insultos' } });

    await reportar.execute(ix);

    assert.match(guild.creados[0].canal.enviados[0].embeds[0].data.description, /No adjuntó link/);
  });

  test('no deja reportarse a uno mismo ni a un bot', async () => {
    const guild = guildFake();
    const yo = comandoFake({ guild, opciones: { usuario: { id: 'user-9', bot: false }, pruebas: 'x' } });
    await reportar.execute(yo);
    assert.match(yo.llamadas.edits[0].embeds[0].data.description, /a vos mismo/);

    const bot = comandoFake({ guild, opciones: { usuario: { id: 'bot-x', bot: true }, pruebas: 'x' } });
    await reportar.execute(bot);
    assert.match(bot.llamadas.edits[0].embeds[0].data.description, /No se puede reportar a un bot/);

    assert.equal(guild.creados.length, 0, 'no abrió ningún ticket');
  });
});
