// Tests de /buscar: el comando con el que el staff audita qué está leyendo la IA.
//
// Lo que se protege: que los resultados lleguen con su fuente y su link (un dato sin
// fuente no es verificable), que se diga cómo clasificaría el bot esa consulta y que
// cuando no hay nada se explique qué probar en vez de mostrar un embed vacío.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-buscar-'));

const comando = require('../src/commands/buscar');
const web = require('../src/utils/web');

const WIKI = {
  query: {
    pages: {
      1: {
        index: 1,
        title: 'Lionel Messi',
        extract: 'Lionel Andrés Messi Cuccittini (Rosario, 24 de junio de 1987) es un futbolista argentino.',
        fullurl: 'https://es.wikipedia.org/wiki/Lionel_Messi',
      },
    },
  },
};

function fetchFalso({ wiki } = {}) {
  return async (url) =>
    String(url).includes('wikipedia')
      ? { ok: true, status: 200, json: async () => wiki ?? {}, text: async () => '' }
      : { ok: false, status: 503, json: async () => ({}), text: async () => '' };
}

function interaccionFake(consulta) {
  const enviados = [];
  return {
    enviados,
    options: { getString: (nombre) => (nombre === 'consulta' ? consulta : null) },
    deferReply: async () => {},
    editReply: async (payload) => {
      enviados.push(payload);
      return payload;
    },
  };
}

const textoDe = (payload) => JSON.stringify(payload.embeds[0].data);

beforeEach(() => {
  web.reiniciar();
  web.usarFetch(fetchFalso());
});

describe('/buscar — búsqueda cruda para el staff', () => {
  test('muestra los resultados con su fuente y su link', async () => {
    web.usarFetch(fetchFalso({ wiki: WIKI }));
    const interaccion = interaccionFake('messi cuantos anios tiene');

    await comando.execute(interaccion);
    const payload = interaccion.enviados.at(-1);
    const embed = payload.embeds[0].data;
    const texto = textoDe(payload);

    assert.match(embed.title, /messi cuantos anios tiene/);
    assert.match(texto, /Wikipedia/);
    assert.match(texto, /Lionel Messi/);
    assert.match(texto, /24 de junio de 1987/);
    assert.match(texto, /https:\/\/es\.wikipedia\.org\/wiki\/Lionel_Messi/);
  });

  test('explica cómo leería el bot esa consulta (la parte auditable)', async () => {
    const general = interaccionFake('messi cuantos anios tiene');
    await comando.execute(general);
    assert.match(general.enviados.at(-1).embeds[0].data.description, /cultura general/);

    const comunidad = interaccionFake('que reglas tiene el server');
    await comando.execute(comunidad);
    assert.match(comunidad.enviados.at(-1).embeds[0].data.description, /no buscaría/);
  });

  test('sin resultados lo dice y sugiere qué probar', async () => {
    const interaccion = interaccionFake('consulta que no existe en ningun lado');
    await comando.execute(interaccion);

    const embed = interaccion.enviados.at(-1).embeds[0].data;
    assert.match(embed.title, /Sin resultados/);
    assert.match(embed.description, /No trajo \*\*nada\*\*/);
    assert.match(embed.description, /menos palabras/);
  });

  test('es un comando de staff y la consulta es obligatoria', () => {
    const json = comando.data.toJSON();
    assert.equal(json.name, 'buscar');
    assert.ok(json.default_member_permissions, '/buscar tiene que declarar permisos de staff');
    assert.equal(json.options[0].name, 'consulta');
    assert.equal(json.options[0].required, true);
    assert.equal(typeof comando.execute, 'function');
  });

  test('la respuesta es efímera (no llena el canal)', async () => {
    const interaccion = interaccionFake('quien fue san martin');
    const defer = interaccion.deferReply;
    let flags = null;
    interaccion.deferReply = async (opciones) => {
      flags = opciones?.flags ?? null;
      return defer();
    };

    await comando.execute(interaccion);
    assert.ok(flags, 'la búsqueda arranca diferida y en privado');
  });
});
