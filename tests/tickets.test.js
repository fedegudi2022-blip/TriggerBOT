// Tests de src/utils/tickets.js — cierre con transcript íntegro y adjuntos grandes.
// Sin red: Discord queda mockeado con objetos literales.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-tickets-'));

const tickets = require('../src/utils/tickets');
const store = require('../src/store');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

const GUILD = 'g-tickets';

// ---------- Fakes ----------

// Discord usa una Collection (Map + helpers como .last()); lo mínimo para el fake.
function coleccion(items) {
  const map = new Map(items);
  map.last = () => [...map.values()][map.size - 1];
  return map;
}
function canalTicketFake({ fallaFetch = false, fallaLogs = false, canalesLogs = {} } = {}) {
  const canal = {
    id: 'canal-ticket-1',
    name: 'ticket-001',
    topic: `${GUILD}:user-1:001`,
    enviados: [],
    deleted: false,
    messages: {
      fetch: async () => {
        if (fallaFetch) throw new Error('Missing Access');
        return coleccion([
          ['m1', { id: 'm1', createdTimestamp: Date.now(), author: { tag: 'u#0001' }, content: 'hola', attachments: new Map() }],
        ]);
      },
    },
  };
  canal.send = async (payload) => {
    canal.enviados.push(payload);
    return { id: `msg-${canal.enviados.length}` };
  };
  canal.delete = async () => {
    canal.deleted = true;
  };

  const cache = new Map(Object.entries(canalesLogs));
  for (const canalLogs of cache.values()) {
    canalLogs.send = async (payload) => {
      if (fallaLogs) throw new Error('Missing Permissions');
      canalLogs.enviados = canalLogs.enviados ?? [];
      canalLogs.enviados.push(payload);
      return { id: 'log-1' };
    };
  }

  canal.guild = {
    id: GUILD,
    name: 'Server de prueba',
    channels: { cache },
    client: { users: { fetch: async () => ({ send: async () => {} }) } },
  };
  return canal;
}

// Texto de todos los embeds enviados al canal, para no depender de la estructura interna.
const textosDelCanal = (canal) =>
  canal.enviados.map((p) => (p.embeds ?? []).map((e) => `${e.data?.title ?? ''} ${e.data?.description ?? ''}`).join(' ')).join(' | ');

describe('dividirTranscript — límite de adjuntos', () => {
  test('parte en varios archivos cuando supera el límite de adjunto', () => {
    const linea = 'x'.repeat(1_000_000);
    const partes = tickets.dividirTranscript('cabecera\n', Array.from({ length: 9 }, (_, i) => `${i}:${linea}`), 'transcript-ticket-001.txt');

    assert.ok(partes.length > 1, 'se dividió en más de un archivo');
    for (const p of partes) assert.ok(p.attachment.length <= tickets.LIMITE_ADJUNTO_BYTES, 'cada parte entra en el límite');
    assert.match(partes[0].name, /parte-1/);
    assert.match(partes[1].name, /parte-2\.txt$/);
  });

  test('no parte un transcript chico', () => {
    const partes = tickets.dividirTranscript('cabecera\n', ['una línea'], 'transcript-ticket-001.txt');
    assert.equal(partes.length, 1);
    assert.equal(partes[0].name, 'transcript-ticket-001.txt');
  });
});

describe('cerrarTicket — no borra si el transcript no quedó a salvo', () => {
  test('sin canal de logs configurado conserva el canal', async () => {
    store.escribir(GUILD, {});
    const canal = canalTicketFake();

    await tickets.cerrarTicket({ channel: canal }, { tag: 'staff#0001' });

    assert.equal(canal.deleted, false, 'el canal NO se borra');
    assert.match(textosDelCanal(canal), /No cerré el ticket/);
  });

  test('si falla la lectura de mensajes (transcript parcial) conserva el canal', async () => {
    store.escribir(GUILD, { tickets: { canalLogs: 'canal-logs' } });
    const canal = canalTicketFake({ fallaFetch: true, canalesLogs: { 'canal-logs': {} } });

    await tickets.cerrarTicket({ channel: canal }, { tag: 'staff#0001' });

    assert.equal(canal.deleted, false, 'el canal NO se borra con un transcript incompleto');
    assert.match(textosDelCanal(canal), /No cerré el ticket/);
  });

  test('si el envío a logs falla conserva el canal', async () => {
    store.escribir(GUILD, { tickets: { canalLogs: 'canal-logs' } });
    const canal = canalTicketFake({ fallaLogs: true, canalesLogs: { 'canal-logs': {} } });

    await tickets.cerrarTicket({ channel: canal }, { tag: 'staff#0001' });

    assert.equal(canal.deleted, false);
    assert.match(textosDelCanal(canal), /No cerré el ticket/);
  });
});
