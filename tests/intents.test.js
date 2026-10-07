// Intents del gateway (utils/intents.js). Importa porque un intent privilegiado pedido
// sin habilitar en el portal deja al bot sin arrancar: la salida PRESENCE_INTENT=false
// tiene que estar probada, y el conteo de «en línea» depende de que el intent llegue de
// verdad al BitField del cliente.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { Client, GatewayIntentBits } = require('discord.js');
const { intentsDe, BASE } = require('../src/utils/intents');
const censo = require('../src/utils/censo');

describe('intents del gateway', () => {
  test('por defecto se pide el Presence Intent (lo necesitan los canales de estadísticas)', () => {
    assert.ok(intentsDe({}).includes(GatewayIntentBits.GuildPresences));
    assert.ok(intentsDe().includes(GatewayIntentBits.GuildPresences));
  });

  test('PRESENCE_INTENT=false es la salida de emergencia y no toca el resto', () => {
    const lista = intentsDe({ PRESENCE_INTENT: 'false' });
    assert.equal(lista.includes(GatewayIntentBits.GuildPresences), false);
    assert.deepEqual(lista, BASE, 'los intents base siguen intactos: el bot arranca igual');
  });

  test('un valor distinto de "false" mantiene el intent', () => {
    for (const valor of ['true', 'TRUE', '', '1']) {
      assert.ok(intentsDe({ PRESENCE_INTENT: valor }).includes(GatewayIntentBits.GuildPresences), `con "${valor}" no debería apagarse`);
    }
  });

  test('el censo lee el intent del cliente real', () => {
    const conPresencias = new Client({ intents: intentsDe({}) });
    assert.equal(censo.tienePresencias(conPresencias), true);

    const sinPresencias = new Client({ intents: intentsDe({ PRESENCE_INTENT: 'false' }) });
    assert.equal(censo.tienePresencias(sinPresencias), false);
  });
});
