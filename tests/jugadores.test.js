// Tests de /jugadores: la lista de conectados de cada server CS 1.6.
//
// El A2S no se toca (sería una consulta UDP real): se reemplaza monitoreo.consultar por
// fixtures. Lo que se verifica es el render (orden, truncado, servers caídos o mudos) y
// que sin configuración no se dispare ninguna consulta.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-jugadores-'));

const comando = require('../src/commands/jugadores');
const monitoreo = require('../src/utils/monitoreo');
const store = require('../src/store');

// ---------- Fakes ----------
function interaccionFake(guildId, { filtro = null } = {}) {
  const respuestas = [];
  const estado = { deferido: false, visibilidad: undefined };
  return {
    guild: { id: guildId },
    guildId,
    user: { id: 'u-1', username: 'u1' },
    options: { getString: () => filtro },
    respuestas,
    estado,
    async deferReply(opciones = {}) {
      estado.deferido = true;
      estado.visibilidad = opciones.flags;
    },
    async reply(payload) {
      respuestas.push(payload);
      return payload;
    },
    async editReply(payload) {
      respuestas.push(payload);
      return payload;
    },
  };
}

const efimero = (payload) => Boolean(payload?.flags && payload.flags & MessageFlags.Ephemeral);
const server = (nombre, puerto, extra = {}) => ({ nombre, host: 'cs.test', puerto, ...extra });
const jugador = (nombre, puntaje, duracion = 120) => ({ nombre, puntaje, duracion });

function ok({ jugadores = 0, maximo = 32, mapa = 'de_dust2', lista = [] } = {}) {
  return { ok: true, datos: { jugadores, maximo, mapa, lista }, latenciaMs: 12 };
}
const CAIDO = { ok: false, error: 'timeout', latenciaMs: 2500 };

const consultas = [];
const fixtures = new Map();
const consultarOriginal = monitoreo.consultar;

before(() => {
  monitoreo.consultar = async (host, puerto) => {
    const clave = `${host}:${puerto}`;
    consultas.push(clave);
    if (!fixtures.has(clave)) throw new Error(`sin fixture para ${clave}`);
    return fixtures.get(clave);
  };
});

after(() => {
  monitoreo.consultar = consultarOriginal;
});

let contador = 0;
function guildCon(servers) {
  const id = `g-jugadores-${++contador}`;
  store.setGuildConfig(id, (c) => {
    c.servidores = { lista: servers };
  });
  return id;
}

describe('/jugadores', () => {
  test('declara cooldown propio: cada uso consulta todos los servers por UDP', () => {
    assert.equal(comando.cooldown, 5);
  });

  test('sin servidores configurados avisa en efímero y no consulta nada', async () => {
    consultas.length = 0;
    const interaccion = interaccionFake(guildCon([]));

    await comando.execute(interaccion);

    assert.equal(consultas.length, 0, 'no se consulta ningún server');
    assert.equal(interaccion.respuestas.length, 1);
    assert.ok(efimero(interaccion.respuestas[0]), 'el aviso de configuración es efímero');
    assert.equal(interaccion.respuestas[0].embeds[0].data.title, 'Sin servidores configurados');
  });

  test('arma un campo por server: ordena por puntaje, cuenta los conectados y marca el caído', async () => {
    consultas.length = 0;
    const guildId = guildCon([server('PUBLICO', 27015), server('KZ', 27016)]);
    fixtures.set('cs.test:27015', ok({ jugadores: 3, lista: [jugador('bajo', 10), jugador('alto', 40, 3600), jugador('medio', 25)] }));
    fixtures.set('cs.test:27016', CAIDO);

    const interaccion = interaccionFake(guildId);
    await comando.execute(interaccion);

    const embed = interaccion.respuestas[0].embeds[0];
    assert.equal(embed.data.title, 'Jugadores conectados');
    assert.match(embed.data.description, /\*\*3\*\* jugador\(es\) en \*\*2\*\* server\(s\)\./);
    assert.equal(embed.data.fields.length, 2);

    const [primero, segundo] = embed.data.fields;
    assert.match(primero.name, /^PUBLICO — 3\/32 · `de_dust2`$/);
    const lineas = primero.value.split('\n');
    assert.match(lineas[0], /^\*\*alto\*\* — 40 pts · 1 h 0 min$/);
    assert.match(lineas[1], /^\*\*medio\*\* — 25 pts · 2 min$/);
    assert.match(lineas[2], /^\*\*bajo\*\* — 10 pts · 2 min$/);

    assert.match(segundo.name, /^KZ — sin respuesta$/);
    assert.equal(segundo.value, '*No responde ahora.*');

    assert.ok(!efimero(interaccion.respuestas[0]), 'con datos responde en público, como /servidores');
    assert.equal(interaccion.estado.deferido, true, 'difiere antes de consultar');
  });

  test('un server lleno se corta y dice cuántos quedaron afuera', async () => {
    consultas.length = 0;
    const guildId = guildCon([server('PUBLICO', 27020)]);
    const lista = Array.from({ length: 25 }, (_, i) => jugador(`jugador-${i + 1}`, 100 - i));
    fixtures.set('cs.test:27020', ok({ jugadores: 25, lista }));

    const interaccion = interaccionFake(guildId);
    await comando.execute(interaccion);

    const valor = interaccion.respuestas[0].embeds[0].data.fields[0].value;
    assert.match(valor, /\*…y 5 más\.\*$/, 'tiene que avisar los 5 que quedaron afuera');
    assert.equal(valor.split('\n').length, 21, '20 jugadores y la línea del resto');
    assert.ok(valor.length <= 1024, `el campo se pasa del límite de Discord: ${valor.length} caracteres`);
  });

  test('distingue un server vacío de uno que no informa la lista', async () => {
    consultas.length = 0;
    const guildId = guildCon([server('VACIO', 27021), server('MUDO', 27022)]);
    fixtures.set('cs.test:27021', ok({ jugadores: 0, lista: [] }));
    fixtures.set('cs.test:27022', ok({ jugadores: 7, lista: [] }));

    const interaccion = interaccionFake(guildId);
    await comando.execute(interaccion);

    const [vacio, mudo] = interaccion.respuestas[0].embeds[0].data.fields;
    assert.equal(vacio.value, '*Sin jugadores conectados.*');
    assert.equal(mudo.value, '*El server no informa su lista de jugadores.*');
  });

  test('el filtro busca por nombre y por modo, sin acentos', async () => {
    consultas.length = 0;
    const guildId = guildCon([server('PÚBLICO CLÁSICO', 27023), server('Mix', 27024, { modo: 'automix' })]);
    fixtures.set('cs.test:27023', ok({ jugadores: 1, lista: [jugador('uno', 5)] }));
    fixtures.set('cs.test:27024', ok({ jugadores: 1, lista: [jugador('dos', 5)] }));

    const porNombre = interaccionFake(guildId, { filtro: 'publico' });
    await comando.execute(porNombre);
    const camposNombre = porNombre.respuestas[0].embeds[0].data.fields;
    assert.equal(camposNombre.length, 1, 'el filtro por nombre trae un solo server');
    assert.match(camposNombre[0].name, /^PÚBLICO CLÁSICO/);

    const porModo = interaccionFake(guildId, { filtro: 'automix' });
    await comando.execute(porModo);
    assert.match(porModo.respuestas[0].embeds[0].data.fields[0].name, /^Mix/);

    assert.equal(consultas.length, 2, 'cada consulta pide solo el server filtrado');
  });

  test('un filtro sin resultados lista los nombres disponibles, en efímero', async () => {
    consultas.length = 0;
    const interaccion = interaccionFake(guildCon([server('PUBLICO', 27025)]), { filtro: 'noexiste' });

    await comando.execute(interaccion);

    assert.equal(consultas.length, 0, 'no se consulta nada si el filtro no encuentra nada');
    assert.ok(efimero(interaccion.respuestas[0]));
    assert.equal(interaccion.respuestas[0].embeds[0].data.title, 'No encontré ese servidor');
    assert.match(interaccion.respuestas[0].embeds[0].data.description, /PUBLICO/);
  });
});
