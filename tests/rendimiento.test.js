// Latencia real por perfil (utils/rendimiento.js + /latencias).
//
// Existe porque /status medía a los PROVEEDORES, no a las respuestas: un rescate con web
// (dos generaciones + búsqueda) tarda varias veces más que una charla y eso no se veía en
// ninguna parte. Lo que se prueba acá es que el perfil, el camino y la causa queden bien
// medidos, y que el detalle que ve el staff explique la demora en palabras.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-rendimiento-'));

const { MessageFlags } = require('discord.js');
const rendimiento = require('../src/utils/rendimiento');
const presupuesto = require('../src/utils/presupuesto');
const { medirSinIA } = require('../src/events/messageCreate');
const comando = require('../src/commands/latencias');

beforeEach(() => {
  rendimiento.reiniciar();
});

describe('medición por perfil', () => {
  test('agrupa por perfil con mediana, peor 5 % y máximo', () => {
    for (const ms of [1000, 2000, 6000]) rendimiento.registrar({ perfil: 'consulta', camino: 'ia', ms, generaciones: 1 });
    rendimiento.registrar({ perfil: 'charla', camino: 'cache', ms: 300 });

    const r = rendimiento.resumen();
    assert.equal(r.total, 4);
    const consulta = r.perfiles.find((p) => p.perfil === 'consulta');
    assert.equal(consulta.n, 3);
    assert.equal(consulta.p50, 2000);
    assert.equal(consulta.p95, 6000);
    assert.equal(consulta.max, 6000);
    assert.equal(consulta.caminos.ia, 3);
    assert.equal(r.perfiles.find((p) => p.perfil === 'charla').caminos.cache, 1);
    assert.deepEqual(
      r.perfiles.map((p) => p.perfil),
      ['charla', 'consulta'],
      'los perfiles salen en orden fijo, no según llegaron'
    );
  });

  test('cada causa de la demora queda separada y con su mediana', () => {
    rendimiento.registrar({ perfil: 'consulta', camino: 'ia', ms: 4000, generaciones: 1, web: 'forzada' });
    rendimiento.registrar({ perfil: 'consulta', camino: 'ia', ms: 7000, generaciones: 2, web: 'paralela' });
    rendimiento.registrar({ perfil: 'consulta', camino: 'ia', ms: 1200, generaciones: 1, web: 'no' });
    rendimiento.registrar({ perfil: 'charla', camino: 'local', ms: 5, sinIA: 'presupuesto' });
    rendimiento.registrar({ perfil: 'consulta', camino: 'cache', ms: 2 });

    const causas = rendimiento.resumen().causas;
    const porId = Object.fromEntries(causas.map((c) => [c.id, c]));

    assert.equal(porId.forzada.n, 1, 'la búsqueda forzada tiene su propia causa');
    assert.equal(porId.forzada.p50, 4000);
    assert.equal(porId.rescate.n, 1);
    assert.equal(porId.rescate.p50, 7000);
    assert.equal(porId.ia.n, 1, 'el camino normal no se mezcla con el rescate');
    assert.equal(porId.sinIA.n, 1);
    assert.equal(porId.instantaneas.n, 1, 'caché y cálculo son la prueba de que hay respuestas instantáneas');
  });

  test('las más lentas salen ordenadas, recortadas y con su pregunta', () => {
    for (let i = 1; i <= 8; i += 1) {
      rendimiento.registrar({ perfil: 'consulta', camino: 'ia', ms: i * 1000, generaciones: 1, pregunta: `pregunta ${i} ${'x'.repeat(200)}` });
    }

    const { lentas } = rendimiento.resumen();
    assert.equal(lentas.length, rendimiento.MAX_LENTAS);
    assert.deepEqual(
      lentas.map((m) => m.ms),
      [8000, 7000, 6000, 5000, 4000]
    );
    assert.ok(lentas[0].pregunta.length <= 90, 'la pregunta se guarda recortada');
    assert.equal(lentas[0].ms, 8000);
  });

  test('la ventana no crece sin control: se conservan las últimas muestras', () => {
    for (let i = 0; i < rendimiento.MAX_MUESTRAS + 20; i += 1) {
      rendimiento.registrar({ perfil: 'consulta', camino: 'ia', ms: 100 + i });
    }

    const r = rendimiento.resumen();
    assert.equal(r.total, rendimiento.MAX_MUESTRAS);
    assert.equal(r.perfiles[0].n, rendimiento.MAX_MUESTRAS);
  });

  test('la causa se puede leer en palabras (es lo que explica la demora)', () => {
    assert.equal(rendimiento.causaDe({ camino: 'calculo', web: 'no' }), 'cálculo exacto (sin IA)');
    assert.equal(rendimiento.causaDe({ camino: 'cache', web: 'no' }), 'respondida de la caché');
    assert.equal(rendimiento.causaDe({ camino: 'local', sinIA: 'presupuesto', web: 'no' }), 'sin IA: presupuesto del día agotado');
    assert.match(rendimiento.causaDe({ camino: 'ia', generaciones: 2, web: 'paralela' }), /rescate con web/);
    assert.match(rendimiento.causaDe({ camino: 'ia', generaciones: 1, web: 'forzada' }), /búsqueda antes de responder/);
  });

  test('formato de duración: milisegundos abajo de un segundo, segundos arriba', () => {
    assert.equal(rendimiento.formatoDeMs(0), '0 ms');
    assert.equal(rendimiento.formatoDeMs(820), '820 ms');
    assert.equal(rendimiento.formatoDeMs(2400), '2,4 s');
    assert.equal(rendimiento.formatoDeMs(12000), '12 s');
  });
});

// ---------- El comando como lo usa el staff ----------
function interaccionFake({ staff = true } = {}) {
  const capturadas = [];
  const miembro = {
    id: staff ? 'staff' : 'raso',
    permissions: { has: () => staff },
    roles: { cache: { has: () => false } },
  };

  return {
    capturadas,
    guild: { id: 'g-latencias', ownerId: 'dueno' },
    guildId: 'g-latencias',
    user: { id: miembro.id, username: 'staff' },
    member: miembro,
    options: { getSubcommand: () => '' },
    reply: async (payload) => {
      capturadas.push(payload);
      return payload;
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      capturadas.push(payload);
      return payload;
    },
  };
}

function textoDe(payload) {
  const embed = payload?.embeds?.[0];
  if (!embed) return '';
  const json = typeof embed.toJSON === 'function' ? embed.toJSON() : embed.data;
  return [json.title, json.description, json.footer?.text, ...(json.fields ?? []).map((f) => `${f.name}: ${f.value}`)]
    .filter(Boolean)
    .join('\n');
}

describe('turnos sin IA (presupuesto agotado o proveedores caídos)', () => {
  const message = { guild: { id: 'g-sin-ia' } };

  test('un turno sin IA queda medido con su motivo, no como si fuera instantáneo', () => {
    presupuesto.reiniciar('g-sin-ia');
    medirSinIA(message, 'que reglas tiene el server', Date.now() - 1500);

    const r = rendimiento.resumen();
    const muestra = r.lentas[0];
    assert.equal(muestra.camino, 'local');
    assert.equal(muestra.sinIA, 'proveedores', 'sin claves o con todo caído el motivo es el proveedor');
    assert.ok(muestra.ms >= 1500, 'se mide el turno completo, no solo la conversación');
    assert.equal(rendimiento.causaDe(muestra), 'sin IA: ningún proveedor respondió');
  });

  test('con el presupuesto agotado el motivo lo dice (es lo accionable para el staff)', () => {
    presupuesto.reiniciar('g-sin-ia');
    for (let i = 0; i < presupuesto.limiteDiario(); i += 1) presupuesto.consumir('g-sin-ia');
    assert.equal(presupuesto.hayCupo('g-sin-ia'), false);

    medirSinIA(message, 'quien es lionel messi', Date.now() - 300, { web: 'directa' });

    const muestra = rendimiento.resumen().lentas[0];
    assert.equal(muestra.sinIA, 'presupuesto');
    assert.equal(rendimiento.causaDe(muestra), 'sin IA: dato de la web directo');
  });
});

describe('el comando /latencias', () => {
  test('sin permiso avisa en efímero y no mide nada', async () => {
    const interaccion = interaccionFake({ staff: false });
    await comando.execute(interaccion);

    assert.ok(interaccion.capturadas[0].flags & MessageFlags.Ephemeral);
    assert.match(textoDe(interaccion.capturadas[0]), /solo para el staff/i);
  });

  test('sin muestras explica que se miden solas', async () => {
    const interaccion = interaccionFake();
    await comando.execute(interaccion);

    assert.match(textoDe(interaccion.capturadas[0]), /Todavía no hay respuestas medidas/);
    assert.ok(interaccion.capturadas[0].flags & MessageFlags.Ephemeral);
  });

  test('con muestras muestra el perfil, la causa y la pregunta más lenta', async () => {
    rendimiento.registrar({ perfil: 'consulta', camino: 'ia', ms: 6800, generaciones: 2, web: 'paralela', pregunta: 'cuantos habitantes tiene cordoba' });
    rendimiento.registrar({ perfil: 'consulta', camino: 'ia', ms: 1200, generaciones: 1, pregunta: 'que reglas tiene el server' });
    rendimiento.registrar({ perfil: 'charla', camino: 'cache', ms: 3, pregunta: 'hola' });

    const interaccion = interaccionFake();
    await comando.execute(interaccion);
    const texto = textoDe(interaccion.capturadas[0]);

    assert.match(texto, /Consulta \(2\)/);
    assert.match(texto, /6,8 s/);
    assert.match(texto, /Rescate con web \(2\+ generaciones\)/);
    assert.match(texto, /cuantos habitantes tiene cordoba/, 'la pregunta concreta se ve, no solo el número');
    assert.ok(texto.length <= 6000, 'el embed no se pasa de lo que acepta Discord');
  });
});
