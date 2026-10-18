// Auditoría de /config: solo se registra lo que cambió, con el actor, y las claves de
// estado vivo (tickets abiertos, encuestas, calificaciones) no generan ruido.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-auditoria-'));

const store = require('../src/store');
const auditoria = require('../src/utils/auditoria');
const panel = require('../src/utils/configPanel');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

function canalFake(id) {
  const canal = { id, enviados: [] };
  canal.send = async (payload) => {
    canal.enviados.push(payload);
    return { id: `msg-${canal.enviados.length}` };
  };
  return canal;
}

function guildFake({ logs = 'canal-logs' } = {}) {
  const guild = {
    id: `g-audit-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Server',
    ownerId: 'dueno-1',
    channels: { cache: new Map() },
    roles: { cache: new Map() },
  };
  if (logs) guild.channels.cache.set(logs, canalFake(logs));
  guild.channels.cache.set('canal-9', canalFake('canal-9'));
  guild.roles.cache.set('rol-nuevo', { id: 'rol-nuevo', name: 'Nuevo' });
  store.escribir(guild.id, { logs, helperRole: 'r-helper' });
  return guild;
}

function interaccionFake(guild, { customId, values = [], tipo = 'select' } = {}) {
  const llamadas = { replies: [], updates: [] };
  const member = {
    id: 'u-1',
    permissions: { has: (p) => p === PermissionFlagsBits.ManageGuild },
    roles: { cache: { has: (id) => id === 'r-helper' } },
  };
  return {
    guild,
    guildId: guild.id,
    user: { id: 'u-1', tag: 'staff#0001', username: 'staff' },
    member,
    customId,
    values,
    isButton: () => tipo === 'button',
    isStringSelectMenu: () => tipo === 'select',
    isAnySelectMenu: () => tipo === 'select',
    isModalSubmit: () => tipo === 'modal',
    isFromMessage: () => false,
    reply: async (p) => {
      llamadas.replies.push(p);
      return p;
    },
    update: async (p) => {
      llamadas.updates.push(p);
      return p;
    },
    showModal: async () => {},
    llamadas,
  };
}

describe('diferencias de configuración', () => {
  test('detecta cambios anidados y no repite lo que no cambió', () => {
    const cambios = auditoria.diferencias(
      { welcome: { channelId: 'a', message: 'hola' }, modlog: 'm1', iaActivada: true },
      { welcome: { channelId: 'b', message: 'hola' }, modlog: 'm1', iaActivada: false }
    );

    assert.deepEqual(
      cambios.map((c) => c.ruta),
      ['iaActivada', 'welcome.channelId']
    );
    assert.equal(cambios[0].antes, true);
    assert.equal(cambios[0].despues, false);
  });

  test('ignora el estado vivo de los tickets', () => {
    const cambios = auditoria.diferencias(
      { tickets: { canalLogs: 'logs', activos: { c1: { ts: 1 } }, encuestas: { u1: {} }, calificaciones: [1] } },
      { tickets: { canalLogs: 'logs2', activos: { c2: { ts: 2 } }, encuestas: {}, calificaciones: [] } }
    );

    assert.deepEqual(
      cambios.map((c) => c.ruta),
      ['tickets.canalLogs']
    );
  });

  test('formatea canales, roles, booleanos y valores vacíos', () => {
    const guild = guildFake();
    assert.equal(auditoria.formatearValor(true), 'sí');
    assert.equal(auditoria.formatearValor(null), '*sin configurar*');
    assert.equal(auditoria.formatearValor('canal-9', guild), '<#canal-9>');
    assert.equal(auditoria.formatearValor('rol-nuevo', guild), '<@&rol-nuevo>');
  });
});

describe('registro de cambios de /config', () => {
  test('manda al canal de logs quién cambió qué y desde dónde', async () => {
    const guild = guildFake();
    const actor = { id: 'u-1', tag: 'staff#0001' };

    const resultado = await auditoria.registrarCambioConfig({
      guild,
      actor,
      seccion: 'Mod-log',
      antes: { logs: 'canal-logs', modlog: null },
      despues: { logs: 'canal-logs', modlog: 'canal-9' },
    });

    assert.equal(resultado.enviado, true);
    const embed = guild.channels.cache.get('canal-logs').enviados[0].embeds[0].data;
    assert.equal(embed.title, 'Configuración modificada');
    assert.match(embed.description, /modlog.*<#canal-9>/);
    assert.equal(embed.author.name, 'staff#0001');
    assert.equal(embed.fields[0].value, 'Mod-log');
  });

  test('el panel de /config audita el cambio real', async () => {
    const guild = guildFake();
    const ix = interaccionFake(guild, { customId: 'cfg:set:modlog:canal', values: ['canal-9'] });

    await panel.manejarComponente(ix);

    assert.equal(store.leer(guild.id).modlog, 'canal-9');
    const enviados = guild.channels.cache.get('canal-logs').enviados;
    assert.equal(enviados.length, 1, 'se registró el cambio en el canal de logs');
    assert.match(enviados[0].embeds[0].data.description, /modlog.*<#canal-9>/);
  });

  test('sin canal de logs no falla ni inventa un destino', async () => {
    const guild = guildFake({ logs: null });
    const resultado = await auditoria.registrarCambioConfig({
      guild,
      actor: { id: 'u-1', tag: 'staff#0001' },
      seccion: 'Mod-log',
      antes: { modlog: null },
      despues: { modlog: 'canal-9' },
    });

    assert.equal(resultado.enviado, false);
    assert.equal(resultado.cambios.length, 1);
  });
});
