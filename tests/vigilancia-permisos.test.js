// Auditoría de permisos: /diag debe decir si al bot le falta escribir en un canal
// configurado, en vez de esperar a que un usuario note que no llegan los logs.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-permisos-'));

const store = require('../src/store');
const { revisarPermisos } = require('../src/utils/vigilancia');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

function guildFake({ permisos, canales = [] } = {}) {
  const cache = new Map(canales.map((c) => [c.id, { name: c.id, ...c }]));
  return {
    id: `g-perm-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Server',
    channels: { cache },
    members: {
      me: {
        id: 'bot-1',
        permissionsIn: () => ({ has: (p) => permisos.has(p) }),
      },
    },
  };
}

const BASE = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

describe('revisarPermisos', () => {
  test('sin canales configurados no hay nada que revisar', () => {
    const guild = guildFake({ permisos: new Set() });
    store.escribir(guild.id, {});
    assert.deepEqual(revisarPermisos(guild), []);
  });

  test('avisa qué permiso falta en el canal de bienvenida', () => {
    const guild = guildFake({
      permisos: new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks]), // falta SendMessages
      canales: [{ id: 'canal-bienvenida' }],
    });
    store.escribir(guild.id, { welcome: { channelId: 'canal-bienvenida' } });

    const problemas = revisarPermisos(guild);

    assert.equal(problemas.length, 1);
    assert.match(problemas[0].titulo, /bienvenida/i);
    assert.match(problemas[0].detalle, /Enviar mensajes/);
    assert.match(problemas[0].accion, /Enviar mensajes/);
    assert.equal(problemas[0].nivel, 'error');
    assert.equal(problemas[0].guildId, guild.id);
  });

  test('detecta un canal borrado a mano', () => {
    const guild = guildFake({ permisos: new Set(BASE) });
    store.escribir(guild.id, { logs: 'canal-fantasma' });

    const [problema] = revisarPermisos(guild);

    assert.match(problema.titulo, /ya no existe/i);
    assert.match(problema.detalle, /canal-fantasma/);
  });

  test('el canal de transcripts necesita además adjuntar archivos', () => {
    const guild = guildFake({
      permisos: new Set(BASE), // sin AttachFiles
      canales: [{ id: 'canal-transcripts' }],
    });
    store.escribir(guild.id, { tickets: { canalLogs: 'canal-transcripts' } });

    const problemas = revisarPermisos(guild);

    assert.equal(problemas.length, 1);
    assert.match(problemas[0].titulo, /tickets/i);
    assert.match(problemas[0].detalle, /Adjuntar archivos/);
  });

  test('la categoría de tickets necesita Gestionar canales', () => {
    const guild = guildFake({
      permisos: new Set(BASE),
      canales: [{ id: 'cat-tickets' }],
    });
    store.escribir(guild.id, { tickets: { categoriaId: 'cat-tickets' } });

    const problemas = revisarPermisos(guild);

    assert.equal(problemas.length, 1);
    assert.match(problemas[0].titulo, /categoría/i);
    assert.match(problemas[0].detalle, /Gestionar canales/);
  });

  test('con todos los permisos no inventa problemas', () => {
    const guild = guildFake({
      permisos: new Set([...BASE, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageChannels]),
      canales: [{ id: 'canal-bienvenida' }, { id: 'canal-transcripts' }, { id: 'cat-tickets' }],
    });
    store.escribir(guild.id, {
      welcome: { channelId: 'canal-bienvenida' },
      tickets: { canalLogs: 'canal-transcripts', categoriaId: 'cat-tickets' },
    });

    assert.deepEqual(revisarPermisos(guild), []);
  });
});
