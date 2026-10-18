// Lo que se veía en los logs de producción:
//   · Cerebras HTTP 402 → probaba los dos modelos, gastaba dos requests y decía
//     "queda como respaldo" sin apartarlo.
//   · Gemini 503 → el cuerpo JSON formateado ocupaba cinco renglones del log.
//   · Node 19 → nadie explicaba por qué el arranque avisaba EBADENGINE.
// Estos tests fijan esas tres correcciones.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-errores-ia-'));

const ia = require('../src/utils/ia');
const vigilancia = require('../src/utils/vigilancia');
const { detalleDeError, castigoPorEstado, esErrorDeProveedor, verificarProveedor, estadoProveedor, proveedoresPausados } = ia._internos;

describe('detalleDeError: una línea legible', () => {
  test('extrae el mensaje del JSON formateado de Gemini y lo deja en una línea', () => {
    const cuerpo = `{
  "error": {
    "code": 503,
    "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary.",
    "status": "UNAVAILABLE"
  }
}`;
    const detalle = detalleDeError(cuerpo);
    assert.equal(detalle, 'This model is currently experiencing high demand. Spikes in demand are usually temporary.');
    assert.ok(!/[\r\n]/.test(detalle), 'no puede conservar saltos de línea');
  });

  test('acepta el formato compacto de otros proveedores y el texto plano', () => {
    assert.equal(detalleDeError('{"message":"Payment required to access this resource."}'), 'Payment required to access this resource.');
    assert.equal(detalleDeError('texto plano\ncon salto'), 'texto plano con salto');
    assert.equal(detalleDeError(''), '');
    assert.equal(detalleDeError(undefined), '');
  });

  test('recorta cuerpos enormes para que no rompan el log', () => {
    const largo = detalleDeError('x'.repeat(1000));
    assert.equal(largo.length, 140);
  });
});

describe('castigoPorEstado', () => {
  test('un 402 aparta la cuenta por horas (pago requerido), no por segundos', () => {
    const castigo = castigoPorEstado(402);
    assert.equal(castigo.ms, 6 * 60 * 60 * 1000);
    assert.match(castigo.motivo, /pago requerido/);
  });

  test('distingue clave inválida, cuota y saturación', () => {
    assert.match(castigoPorEstado(401).motivo, /clave/);
    assert.match(castigoPorEstado(429).motivo, /cuota/);
    assert.match(castigoPorEstado(503).motivo, /saturado/);
    assert.equal(castigoPorEstado(429).ms, 60_000);
    assert.equal(castigoPorEstado(503).ms, 60_000);
  });

  test('en el chat solo los errores de cuenta/clave/cuota apartan el proveedor', () => {
    // Un 5xx puede ser un modelo saturado: se prueba el siguiente modelo del mismo
    // proveedor antes de descartarlo.
    for (const status of [401, 402, 403, 429]) assert.equal(esErrorDeProveedor(status), true, `status ${status}`);
    for (const status of [null, 400, 404, 500, 503]) assert.equal(esErrorDeProveedor(status), false, `status ${status}`);
  });
});

describe('Cerebras 402 (el caso del log)', () => {
  test('aparta el proveedor con un solo request, sin probar el segundo modelo', async () => {
    process.env.CEREBRAS_API_KEY = 'clave-de-prueba';
    proveedoresPausados.delete('cerebras');

    const fetchOriginal = global.fetch;
    let pedidosDeChat = 0;
    global.fetch = async (url) => {
      const destino = String(url);
      if (destino.endsWith('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'gpt-oss-120b' }, { id: 'qwen-3.8-27b' }] }) };
      }
      pedidosDeChat += 1;
      return {
        ok: false,
        status: 402,
        text: async () => '{"message":"Payment required to access this resource. Visit your billing tab."}',
      };
    };

    try {
      await verificarProveedor('cerebras');
    } finally {
      global.fetch = fetchOriginal;
      delete process.env.CEREBRAS_API_KEY;
    }

    const estado = estadoProveedor('cerebras');
    assert.equal(estado.pausado, true, 'el proveedor tiene que quedar en pausa');
    assert.match(estado.motivo, /pago requerido/);
    assert.equal(pedidosDeChat, 1, 'con un error de cuenta no se prueba otro modelo');
  });
});

describe('diagnóstico de entorno (Node)', () => {
  test('Node 19 aparece en /diag como aviso con la acción concreta', () => {
    const problemas = vigilancia.revisarEntorno('19.9.0');
    assert.equal(problemas.length, 1);
    assert.equal(problemas[0].id, 'entorno-node');
    assert.equal(problemas[0].nivel, 'aviso');
    assert.match(problemas[0].detalle, /EBADENGINE/);
    assert.match(problemas[0].accion, /nodejs_22/);
  });

  test('Node 22 o superior no genera ningún aviso', () => {
    assert.deepEqual(vigilancia.revisarEntorno('22.14.0'), []);
    assert.deepEqual(vigilancia.revisarEntorno('24.1.0'), []);
  });
});
