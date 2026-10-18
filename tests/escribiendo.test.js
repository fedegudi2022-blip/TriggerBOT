// El indicador de "escribiendo…" tiene que refrescarse durante un turno largo y cortarse
// al terminar: si sigue vivo después de responder, el canal muestra actividad fantasma.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { mantenerEscribiendo, INTERVALO_POR_DEFECTO_MS } = require('../src/utils/escribiendo');

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mantenerEscribiendo', () => {
  test('manda el indicador al empezar y lo refresca mientras dura el turno', async () => {
    let llamadas = 0;
    const canal = { sendTyping: async () => (llamadas += 1) };

    const detener = mantenerEscribiendo(canal, { intervalo: 15 });
    await esperar(60);
    const durante = llamadas;
    detener();

    assert.ok(durante >= 3, `se esperaban al menos 3 refrescos, hubo ${durante}`);
  });

  test('al detenerlo deja de mandar (no queda actividad fantasma)', async () => {
    let llamadas = 0;
    const canal = { sendTyping: async () => (llamadas += 1) };

    const detener = mantenerEscribiendo(canal, { intervalo: 10 });
    detener();
    detener(); // idempotente
    const alCortar = llamadas;
    await esperar(40);
    assert.equal(llamadas, alCortar);
  });

  test('un canal sin sendTyping no rompe (canal borrado o de otro tipo)', () => {
    const detener = mantenerEscribiendo(null);
    assert.equal(typeof detener, 'function');
    detener();
  });

  test('si Discord rechaza el indicador, la respuesta sigue igual', async () => {
    const canal = {
      sendTyping: async () => {
        throw new Error('Missing Permissions');
      },
    };
    const detener = mantenerEscribiendo(canal, { intervalo: 10 });
    await esperar(25);
    detener();
    // Llegar acá sin excepción no manejada es el resultado esperado.
    assert.ok(true);
  });
});
