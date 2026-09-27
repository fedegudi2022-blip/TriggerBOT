// Tests de la auditoría de moderación (/casos y /nota), el registro persistente de
// casos y el detalle de comandos de /help. Discord mockeado con objetos literales.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-audit-'));

const casos = require('../src/casos');
const notas = require('../src/notas');
const warns = require('../src/warns');
const store = require('../src/store');
const { logAction } = require('../src/utils/modlog');
const { COLORS } = require('../src/utils/replies');
const { detalleDeComando } = require('../src/utils/guia');
const { cargarComandos } = require('../src/commandLoader');
const casosCmd = require('../src/commands/casos');
const notaCmd = require('../src/commands/nota');
const helpCmd = require('../src/commands/help');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

let contador = 0;

function guildFake() {
  contador += 1;
  const id = `g-audit-${contador}`;
  const canal = {
    id: 'modlog-1',
    name: 'modlog',
    enviados: [],
    send: async (payload) => {
      canal.enviados.push(payload);
      return { id: 'msg-1' };
    },
  };
  const guild = { id, name: 'Server', channels: { cache: new Map([[canal.id, canal]]) }, client: { user: { id: 'bot' } }, canal };
  store.escribir(id, { modlog: 'modlog-1' });
  return guild;
}

// Interacción genérica con opciones y permisos de staff.
function interaccionFake(guild, { opciones = {}, permisos = true } = {}) {
  const llamadas = { replies: [], responds: [] };
  const ix = {
    guild,
    guildId: guild.id,
    user: { id: 'staff-1', tag: 'staff#0001', username: 'staff-1' },
    member: { permissions: { has: () => permisos }, roles: { cache: { has: () => false } } },
    client: { commands: comandos },
    options: {
      getInteger: (n) => opciones[n] ?? null,
      getUser: (n) => opciones[n] ?? null,
      getString: (n) => opciones[n] ?? null,
      getSubcommand: () => opciones.sub ?? null,
      getFocused: () => opciones.focused ?? '',
    },
    async reply(payload) {
      llamadas.replies.push(payload);
      return payload;
    },
    async respond(opcionesRespondidas) {
      llamadas.responds.push(opcionesRespondidas);
    },
  };
  return { ix, llamadas };
}

const texto = (embed) => {
  const data = embed.data ?? embed;
  return [data.title, data.description, ...(data.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n');
};

const comandos = new Map(cargarComandos().map((c) => [c.data.name, c]));

describe('registro persistente de casos (modlog + casos.js)', () => {
  test('logAction guarda el caso con su número, objetivo y moderador', () => {
    const guild = guildFake();
    const numero = logAction(guild, {
      action: 'Baneo (ban)',
      color: COLORS.error,
      target: { id: 'user-1', tag: 'user#0001' },
      moderator: { id: 'mod-1', tag: 'mod#0001' },
      reason: 'raid',
    });

    assert.equal(numero, 1);
    const caso = casos.obtener(guild.id, 1);
    assert.equal(caso.action, 'Baneo (ban)');
    assert.equal(caso.targetId, 'user-1');
    assert.equal(caso.moderatorId, 'mod-1');
    assert.equal(caso.reason, 'raid');
    assert.equal(casos.listar(guild.id).length, 1);
  });

  test('los casos se numeran por servidor y listar() devuelve del más nuevo al más viejo', () => {
    const guild = guildFake();
    logAction(guild, { action: 'Uno', target: { id: 'a' }, moderator: { id: 'm' } });
    logAction(guild, { action: 'Dos', target: { id: 'b' }, moderator: { id: 'm' } });

    const lista = casos.listar(guild.id);
    assert.deepEqual(
      lista.map((c) => c.numero),
      [2, 1]
    );
    assert.equal(casos.listar(guild.id, { usuarioId: 'b' }).length, 1);
  });
});

describe('/casos', () => {
  test('muestra un caso puntual por número', async () => {
    const guild = guildFake();
    logAction(guild, {
      action: 'Silencio (timeout)',
      color: COLORS.warn,
      target: { id: 'user-9', tag: 'user#0009' },
      moderator: { id: 'mod-1' },
      reason: 'flood',
    });
    const { ix, llamadas } = interaccionFake(guild, { opciones: { caso: 1 } });

    await casosCmd.execute(ix);

    assert.equal(llamadas.replies.length, 1);
    const t = texto(llamadas.replies[0].embeds[0]);
    assert.match(t, /Caso #1/);
    assert.match(t, /Silencio \(timeout\)/);
    assert.match(t, /flood/);
  });

  test('lista los casos de un usuario', async () => {
    const guild = guildFake();
    logAction(guild, { action: 'Ban', target: { id: 'user-x' }, moderator: { id: 'mod-1' }, reason: 'uno' });
    logAction(guild, { action: 'Kick', target: { id: 'user-x' }, moderator: { id: 'mod-1' }, reason: 'dos' });
    logAction(guild, { action: 'Ban', target: { id: 'otro' }, moderator: { id: 'mod-1' } });

    const { ix, llamadas } = interaccionFake(guild, { opciones: { usuario: { id: 'user-x', tag: 'user-x#0001' } } });
    await casosCmd.execute(ix);

    const t = texto(llamadas.replies[0].embeds[0]);
    assert.match(t, /Casos de user-x/);
    assert.match(t, /#2 — Kick/);
    assert.match(t, /#1 — Ban/);
    assert.doesNotMatch(t, /otro/);
  });

  test('un miembro común no puede consultar el registro', async () => {
    const guild = guildFake();
    const { ix, llamadas } = interaccionFake(guild, { permisos: false });
    await casosCmd.execute(ix);
    assert.match(texto(llamadas.replies[0].embeds[0]), /Solo staff/);
  });
});

describe('/nota — notas internas separadas de los warns', () => {
  test('agregar no toca el historial de advertencias y ver las muestra', async () => {
    const guild = guildFake();
    const usuario = { id: 'user-nota', tag: 'user-nota#0001' };

    const alta = interaccionFake(guild, { opciones: { sub: 'agregar', usuario, texto: ' Habló con el staff ' } });
    await notaCmd.execute(alta.ix);

    assert.equal(notas.getNotas(guild.id, usuario.id).length, 1);
    assert.equal(notas.getNotas(guild.id, usuario.id)[0].moderatorId, 'staff-1');
    assert.equal(warns.getWarns(guild.id, usuario.id).length, 0, 'una nota NO es una advertencia');

    const ver = interaccionFake(guild, { opciones: { sub: 'ver', usuario } });
    await notaCmd.execute(ver.ix);
    assert.match(texto(ver.llamadas.replies[0].embeds[0]), /Habló con el staff/);
  });

  test('quitar borra la nota indicada por número', async () => {
    const guild = guildFake();
    const usuario = { id: 'user-nota2', tag: 'user-nota2#0001' };
    const alta = interaccionFake(guild, { opciones: { sub: 'agregar', usuario, texto: 'primera' } });
    await notaCmd.execute(alta.ix);

    const baja = interaccionFake(guild, { opciones: { sub: 'quitar', usuario, numero: 1 } });
    await notaCmd.execute(baja.ix);

    assert.equal(notas.getNotas(guild.id, usuario.id).length, 0);
    assert.match(texto(baja.llamadas.replies[0].embeds[0]), /Nota eliminada/);
  });
});

describe('/help — detalle por comando', () => {
  test('el detalle muestra el permiso y las opciones reales', () => {
    const detalle = detalleDeComando({ commands: comandos }, 'ban');
    const t = texto(detalle);
    assert.match(t, /\/ban/);
    assert.match(t, /Banear miembros/);
    assert.match(t, /usuario/);
  });

  test('un comando público dice que es para todos', () => {
    assert.match(texto(detalleDeComando({ commands: comandos }, 'top')), /Todos/);
  });

  test('el autocompletado de la guía pública no ofrece comandos de staff', async () => {
    const guild = guildFake();
    const { ix, llamadas } = interaccionFake(guild, { opciones: { sub: 'user', focused: '' } });
    await helpCmd.autocomplete(ix);
    const nombres = llamadas.responds[0].map((o) => o.value);
    assert.ok(nombres.includes('top'), 'ofrece /top');
    assert.ok(!nombres.includes('ban'), 'no ofrece /ban (staff)');
  });

  test('el autocompletado de staff sí ofrece los de moderación', async () => {
    const guild = guildFake();
    const { ix, llamadas } = interaccionFake(guild, { opciones: { sub: 'staff', focused: 'top' } });
    await helpCmd.autocomplete(ix);
    assert.deepEqual(
      llamadas.responds[0].map((o) => o.value),
      ['top']
    );
  });
});
