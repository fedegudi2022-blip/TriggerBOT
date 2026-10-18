// Errores de interacción: cada fallo inesperado lleva un código corto que el usuario
// puede pasarle al staff y que aparece en el log junto al stack.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { responderError, codigoDeError } = require('../src/utils/errores');
const { MessageFlags } = require('discord.js');

describe('código de error', () => {
  test('tiene el formato TB-XXXXX y no se repite en llamadas seguidas', () => {
    const codigos = new Set();
    for (let i = 0; i < 50; i++) codigos.add(codigoDeError());
    assert.equal(codigos.size, 50);
    for (const codigo of codigos) assert.match(codigo, /^TB-[0-9A-Z]{5}$/);
  });
});

function interaccionFalsa({ replied = false, deferred = false, respuestaFalla = false } = {}) {
  const respuestas = [];
  return {
    respuestas,
    replied,
    deferred,
    reply: async (payload) => {
      if (respuestaFalla) throw new Error('interacción expirada');
      respuestas.push({ tipo: 'reply', payload });
    },
    followUp: async (payload) => {
      respuestas.push({ tipo: 'followUp', payload });
    },
  };
}

describe('responderError', () => {
  test('contesta en efímero con el código y lo devuelve', async () => {
    const errorOriginal = console.error;
    console.error = () => {}; // el log del test no ensucia la salida
    try {
      const interaccion = interaccionFalsa();
      const codigo = await responderError(interaccion, new Error('boom'), { que: 'ejecutar /test' });

      assert.equal(interaccion.respuestas.length, 1);
      const { tipo, payload } = interaccion.respuestas[0];
      assert.equal(tipo, 'reply');
      assert.ok(payload.flags & MessageFlags.Ephemeral);
      assert.match(payload.content, /ejecutar \/test/);
      assert.ok(payload.content.includes(codigo));
    } finally {
      console.error = errorOriginal;
    }
  });

  test('si ya se había contestado usa followUp (no puede volver a responder)', async () => {
    const errorOriginal = console.error;
    console.error = () => {};
    try {
      const interaccion = interaccionFalsa({ replied: true });
      await responderError(interaccion, new Error('boom'));
      assert.equal(interaccion.respuestas[0].tipo, 'followUp');
    } finally {
      console.error = errorOriginal;
    }
  });

  test('si la interacción ya expiró, no tira hacia afuera', async () => {
    const errorOriginal = console.error;
    console.error = () => {};
    try {
      const interaccion = interaccionFalsa({ respuestaFalla: true });
      const codigo = await responderError(interaccion, new Error('boom'));
      assert.match(codigo, /^TB-/);
    } finally {
      console.error = errorOriginal;
    }
  });
});
