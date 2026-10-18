// Las respuestas de la IA son texto libre: si repiten un @everyone o una mención, no
// deben sonar notificaciones. `parse: []` deja el texto visible pero apaga el ping.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.TRIGGER_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tgb-menciones-'));

const { responderTexto, SIN_MENCIONES } = require('../src/events/messageCreate');

function mensajeFake() {
  const enviados = [];
  return {
    enviados,
    reply: async (p) => {
      enviados.push({ canal: 'reply', ...p });
      return { id: 'r1' };
    },
    channel: {
      send: async (p) => {
        enviados.push({ canal: 'channel', ...p });
        return { id: 'c1' };
      },
    },
  };
}

test('el texto de la IA se envía sin menciones, también cuando va en varios mensajes', async () => {
  const message = mensajeFake();
  const largo = `${'@everyone '.repeat(300)}\n<@123456789012345678>`;

  await responderTexto(message, largo);

  assert.ok(message.enviados.length > 1, 'un texto largo se parte en varios mensajes');
  for (const envio of message.enviados) {
    assert.deepEqual(envio.allowedMentions, SIN_MENCIONES);
    assert.deepEqual(envio.allowedMentions, { parse: [] });
  }
  assert.match(message.enviados.map((e) => e.content).join(' '), /@everyone/);
});

test('un texto corto usa una sola respuesta con el mismo filtro', async () => {
  const message = mensajeFake();
  await responderTexto(message, 'Hola <@123456789012345678>, @everyone');

  assert.equal(message.enviados.length, 1);
  assert.equal(message.enviados[0].canal, 'reply');
  assert.deepEqual(message.enviados[0].allowedMentions, { parse: [] });
});
