// Tests de la vigilancia (utils/vigilancia.js) y de /diag.
//
// Lo que se protege acá: que un problema real se detecte, que avise UNA sola vez, que
// avise de nuevo cuando empeora, que avise cuando se resuelve y que /diag muestre
// exactamente lo mismo que el aviso automático (comparten el núcleo `revisar`).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-vig-'));

const vigilancia = require('../src/utils/vigilancia');
const store = require('../src/store');
const db = require('../src/db/mariadb');
const monitoreo = require('../src/utils/monitoreo');
const ia = require('../src/utils/ia');
const diag = require('../src/commands/diag');

const GUID = 'g-vig-1';

// ---------- Fakes ----------
function canalFake(id) {
  const canal = {
    id,
    name: id,
    enviados: [],
    send: async (payload) => {
      canal.enviados.push(payload);
      return { id: 'msg-1' };
    },
  };
  return canal;
}

function guildFake({ conAvisos = true } = {}) {
  const canales = new Map();
  if (conAvisos) canales.set('avisos-1', canalFake('avisos-1'));
  return {
    id: GUID,
    name: 'TriGGer.Arena',
    channels: { cache: canales },
    members: {
      me: { permissions: { has: () => true } },
    },
    client: { readyTimestamp: Date.now() - 600_000 },
  };
}

function clientFake(guild) {
  return {
    guilds: { cache: new Map(guild ? [[guild.id, guild]] : []) },
    commands: new Map([['diag', diag]]),
    fallosCarga: [],
    ws: { ping: 42 },
  };
}

// Config del guild en el store real (mismo módulo que usa la vigilancia).
function configurar(extra = {}) {
  store.escribir(GUID, { avisosChannel: 'avisos-1', ...extra });
}

// Las claves de IA se borran para que ningún test dependa de la máquina donde corre
// (y para que /diag nunca salga a la red).
function sinClavesIA() {
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.MISTRAL_API_KEY;
}

const reset = () => {
  vigilancia.olvidarAvisos();
  sinClavesIA();
  store.escribir(GUID, {});
};

describe('chequeos de la vigilancia', () => {
  test('un modelo retirado que deja a la IA sin alternativas se detecta como error', () => {
    reset();
    process.env.GROQ_API_KEY = 'clave';
    // Es el caso del log real: Groq responde 404 por un modelo que ya no existe.
    ia._internos.marcarModeloCaido('groq', 'llama-3.3-70b-versatile', 'HTTP 404');
    const problemas = vigilancia.revisarIA();
    sinClavesIA();

    const sinModelos = problemas.find((p) => p.id === 'ia-groq-sin-modelos');
    assert.ok(sinModelos, 'debería avisar que Groq no tiene modelos usables');
    assert.equal(sinModelos.nivel, 'error');
    assert.match(sinModelos.detalle, /llama-3\.3-70b-versatile/);
    assert.ok(sinModelos.accion.length > 20, 'tiene que decir qué hacer');
  });

  test('sin ninguna clave de IA no hay problema (es una configuración válida)', () => {
    reset();
    assert.deepEqual(vigilancia.revisarIA(), []);
  });

  test('un proveedor en pausa se reporta con el motivo y cuánto falta', () => {
    reset();
    process.env.GEMINI_API_KEY = 'clave';
    ia._internos.pausarProveedor('gemini', 60_000, 'HTTP 401: clave inválida');
    const problemas = vigilancia.revisarIA();
    sinClavesIA();

    const pausa = problemas.find((p) => p.id === 'ia-gemini-pausa');
    assert.ok(pausa, 'debería avisar que Gemini está apartado');
    assert.match(pausa.detalle, /clave inválida/);
    assert.match(pausa.detalle, /1 min/);
  });

  test('cualquier proveedor de la cadena se vigila igual, no solo Groq y Gemini', () => {
    reset();
    process.env.CEREBRAS_API_KEY = 'clave';
    ia._internos.pausarProveedor('cerebras', 60_000, 'HTTP 429: cuota agotada');
    const problemas = vigilancia.revisarIA();
    sinClavesIA();

    const pausa = problemas.find((p) => p.id === 'ia-cerebras-pausa');
    assert.ok(pausa, 'debería avisar que Cerebras está apartado');
    assert.equal(pausa.nivel, 'error');
    assert.match(pausa.detalle, /cuota agotada/);
    assert.match(pausa.accion, /cloud\.cerebras\.ai/, 'la acción dice dónde revisar la clave');
  });

  test('una base de conocimiento vacía se detecta (la IA respondería a ciegas)', () => {
    const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-vig-kb-'));
    const problemas = vigilancia.revisarConocimiento(vacio);
    assert.equal(problemas.length, 1);
    assert.equal(problemas[0].id, 'conocimiento-vacio');
    assert.equal(problemas[0].nivel, 'error');
    // Y con la base real que se distribuye no hay nada que avisar.
    assert.deepEqual(vigilancia.revisarConocimiento(), []);
  });

  test('un archivo que no se pudo cargar se reporta con el motivo', () => {
    const client = clientFake();
    client.fallosCarga = [{ archivo: 'ping.js', motivo: 'descripción demasiado larga' }];
    const problemas = vigilancia.revisarCarga(client);

    assert.equal(problemas.length, 1);
    assert.match(problemas[0].detalle, /`ping\.js`: descripción demasiado larga/);
    assert.match(problemas[0].titulo, /1 archivo/);
    assert.deepEqual(vigilancia.revisarCarga(clientFake()), [], 'sin fallos no hay nada que reportar');
  });

  test('la base conectada sin permiso de escritura avisa (estaría perdiendo respaldos)', async () => {
    // El entorno de tests no tiene base configurada: se fuerza el estado en el módulo
    // (es la única forma de ejercitar la rama sin una MariaDB de verdad).
    const configuradaOriginal = db.configurada;
    const { conectado, permisoEscritura } = db.estado;
    db.configurada = true;
    db.estado.conectado = true;
    db.estado.permisoEscritura = false;

    const problemas = await vigilancia.revisarBaseDeDatos();

    db.configurada = configuradaOriginal;
    db.estado.conectado = conectado;
    db.estado.permisoEscritura = permisoEscritura;

    assert.ok(problemas.some((p) => p.id === 'db-sin-permiso'));
    assert.ok(problemas.every((p) => p.nivel === 'error'));
  });

  test('sin base configurada no se avisa nada (el bot funciona con data/ local)', async () => {
    const configuradaOriginal = db.configurada;
    db.configurada = false;
    const problemas = await vigilancia.revisarBaseDeDatos();
    db.configurada = configuradaOriginal;
    assert.deepEqual(problemas, []);
  });

  test('el monitoreo de servidores quieto se detecta por la antigüedad del dato', () => {
    configurar({ servidores: { lista: [{ nombre: 'Público', host: '10.0.0.1', puerto: 27015 }] } });
    const guild = guildFake();

    // Dato viejo: el tick dejó de correr (el intervalo real es de 90 s).
    monitoreo.cache.set('10.0.0.1:27015', { ok: true, cuando: Date.now() - 10 * 60_000, host: '10.0.0.1', puerto: 27015 });
    const problemas = vigilancia.revisarServidores(guild);
    monitoreo.cache.delete('10.0.0.1:27015');

    assert.equal(problemas.length, 1);
    assert.equal(problemas[0].id, `servidores-${GUID}-viejo`);
    assert.equal(problemas[0].guildId, GUID, 'el problema sabe de qué servidor es');
    assert.equal(problemas[0].nivel, 'aviso');
  });

  test('una lista de servidores vacía no genera ruido', () => {
    reset();
    assert.deepEqual(vigilancia.revisarServidores(guildFake()), []);
  });

  test('los problemas de voz salen del diagnóstico compartido con /voz estado', () => {
    reset();
    // Hub configurado que ya no existe: lo que pasa cuando alguien lo borra a mano.
    configurar({ voz: { hubId: 'hub-borrado' } });
    const guild = guildFake();

    const problemas = vigilancia.revisarVoz(guild);
    assert.equal(problemas.length, 1);
    assert.equal(problemas[0].nivel, 'error');
    assert.match(problemas[0].detalle, /hub/i);
    assert.equal(problemas[0].guildId, guild.id);
    // El id sale del texto, no de la posición en la lista.
    assert.equal(problemas[0].id, `voz-${GUID}-${vigilancia.slug(problemas[0].detalle)}`);
  });

  test('un servidor con el sistema de voz sin activar no genera ruido', () => {
    reset();
    assert.deepEqual(vigilancia.revisarVoz(guildFake()), []);
  });

  test('la búsqueda web sin salida a internet se detecta (y no deja el bot a ciegas)', async () => {
    const web = require('../src/utils/web');
    const fetchOriginal = global.fetch;
    web.usarFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND es.wikipedia.org');
    });

    try {
      await web.verificar({ forzar: true });
      const problemas = await vigilancia.revisarWeb();
      assert.equal(problemas.length, 1);
      assert.equal(problemas[0].id, 'web-sin-salida');
      assert.equal(problemas[0].nivel, 'aviso');
      assert.match(problemas[0].detalle, /ENOTFOUND/);
      assert.ok(problemas[0].accion.length > 30, 'dice qué revisar');
    } finally {
      web.usarFetch((url, opciones) => fetchOriginal(url, opciones));
      web.reiniciar();
    }
  });

  test('con internet OK la búsqueda no genera ninguna queja', async () => {
    const web = require('../src/utils/web');
    web.usarFetch(async (url) =>
      String(url).includes('wikipedia')
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              query: {
                pages: {
                  1: { index: 1, title: 'Enciclopedia', extract: 'Una enciclopedia es...', fullurl: 'https://es.wikipedia.org/wiki/Enciclopedia' },
                },
              },
            }),
            text: async () => '',
          }
        : { ok: false, status: 503, json: async () => ({}), text: async () => '' }
    );

    await web.verificar({ forzar: true });
    assert.deepEqual(await vigilancia.revisarWeb(), []);
  });

  test('el presupuesto de IA agotado se avisa una vez por día (con acción)', () => {
    reset();
    const presupuesto = require('../src/utils/presupuesto');
    const limiteAntes = process.env.IA_LIMITE_DIARIO;
    process.env.IA_LIMITE_DIARIO = '1';

    try {
      presupuesto.reiniciar(GUID);
      presupuesto.consumir(GUID);
      presupuesto.consumir(GUID); // segundo intento: ya no hay cupo

      const problemas = vigilancia.revisarPresupuesto(guildFake());
      assert.equal(problemas.length, 1);
      assert.equal(problemas[0].nivel, 'error');
      assert.equal(problemas[0].guildId, GUID);
      assert.match(problemas[0].id, new RegExp(`^ia-presupuesto-${GUID}-\\d{4}-\\d{2}-\\d{2}$`), 'el id lleva el día');
      assert.match(problemas[0].detalle, /repertorio local/);

      // Con cupo disponible no hay nada que reportar.
      presupuesto.reiniciar(GUID);
      assert.deepEqual(vigilancia.revisarPresupuesto(guildFake()), []);
    } finally {
      if (limiteAntes === undefined) delete process.env.IA_LIMITE_DIARIO;
      else process.env.IA_LIMITE_DIARIO = limiteAntes;
      presupuesto.reiniciar(GUID);
    }
  });

  test('los chequeos asíncronos NO se pierden en la revisión completa', async () => {
    // Bug real: `correr` no esperaba la promesa, así que los problemas de la base de
    // datos (el único chequeo async) nunca llegaban ni a /diag ni a los avisos.
    reset();
    const configuradaOriginal = db.configurada;
    const { conectado, permisoEscritura } = db.estado;
    db.configurada = true;
    db.estado.conectado = true;
    db.estado.permisoEscritura = false;

    try {
      const { problemas, chequeos } = await vigilancia.revisar(clientFake(guildFake()), { ping: false });
      assert.ok(
        problemas.some((p) => p.id === 'db-sin-permiso'),
        '/diag tiene que ver la base sin permiso'
      );
      assert.ok(chequeos.includes('Base de datos'));
    } finally {
      db.configurada = configuradaOriginal;
      db.estado.conectado = conectado;
      db.estado.permisoEscritura = permisoEscritura;
    }
  });

  test('la prueba de internet solo corre cuando la pide /diag, no en cada vigilancia', async () => {
    reset();
    const client = clientFake(guildFake());

    const sinWeb = await vigilancia.revisar(client, { ping: false });
    assert.ok(!sinWeb.chequeos.includes('Búsqueda web'), 'la vigilancia automática no sale a internet');

    const web = require('../src/utils/web');
    web.usarFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ query: { pages: { 1: { index: 1, title: 'X', extract: 'Y', fullurl: 'https://es.wikipedia.org/wiki/X' } } } }),
      text: async () => '',
    }));
    const conWeb = await vigilancia.revisar(client, { ping: false, web: true });
    assert.ok(conWeb.chequeos.includes('Búsqueda web'));
  });
});

describe('regla de avisos (comparar)', () => {
  const p = (id, nivel) => [id, { id, nivel, titulo: id, detalle: '', accion: '' }];

  test('lo nuevo se avisa y lo igual no se repite', () => {
    const previos = new Map([p('a', 'error')]);
    const actuales = new Map([p('a', 'error'), p('b', 'aviso')]);
    const { nuevos, resueltos } = vigilancia.comparar(previos, actuales);

    assert.deepEqual(
      nuevos.map((x) => x.id),
      ['b']
    );
    assert.deepEqual(resueltos, []);
  });

  test('de aviso a error se vuelve a avisar (empeoró)', () => {
    const previos = new Map([p('a', 'aviso')]);
    const actuales = new Map([p('a', 'error')]);
    const { nuevos } = vigilancia.comparar(previos, actuales);
    assert.deepEqual(
      nuevos.map((x) => x.id),
      ['a']
    );
  });

  test('de error a aviso NO se vuelve a avisar (no molesta de nuevo)', () => {
    const previos = new Map([p('a', 'error')]);
    const actuales = new Map([p('a', 'aviso')]);
    assert.deepEqual(vigilancia.comparar(previos, actuales).nuevos, []);
  });

  test('lo que desaparece se reporta como resuelto', () => {
    const previos = new Map([p('a', 'error'), p('b', 'aviso')]);
    const actuales = new Map([p('b', 'aviso')]);
    const { resueltos } = vigilancia.comparar(previos, actuales);
    assert.deepEqual(
      resueltos.map((x) => x.id),
      ['a']
    );
  });
});

describe('avisos automáticos (vigilar)', () => {
  test('avisa una sola vez por problema y avisa cuando se resuelve', async () => {
    reset();
    configurar({ voz: { hubId: 'hub-borrado' } });
    const guild = guildFake();
    const client = clientFake(guild);

    const primera = await vigilancia.vigilar(client);
    assert.ok(
      primera.nuevos.some((x) => x.id.startsWith('voz-')),
      'detecta y avisa el problema'
    );
    assert.equal(guild.channels.cache.get('avisos-1').enviados.length, 1, 'un solo mensaje de aviso');
    assert.match(JSON.stringify(guild.channels.cache.get('avisos-1').enviados[0]), /hub/);

    // Segunda pasada sin cambios: no repite el aviso (esto es lo que evita el spam).
    const segunda = await vigilancia.vigilar(client);
    assert.deepEqual(segunda.nuevos, []);
    assert.deepEqual(segunda.resueltos, []);
    assert.equal(guild.channels.cache.get('avisos-1').enviados.length, 1, 'no repite el mismo aviso');

    // Se resuelve (se borra la config de voz) → avisa que volvió a la normal.
    configurar();
    const tercera = await vigilancia.vigilar(client);
    assert.ok(
      tercera.resueltos.some((x) => x.id.startsWith('voz-')),
      'reporta la resolución'
    );
    assert.equal(guild.channels.cache.get('avisos-1').enviados.length, 2, 'un segundo mensaje, ahora de resolución');
    assert.match(JSON.stringify(guild.channels.cache.get('avisos-1').enviados[1]), /volvió a la normal/i);
  });

  test('sin canal de avisos no se envía nada, pero /diag lo sigue mostrando', async () => {
    reset();
    store.escribir(GUID, { voz: { hubId: 'hub-borrado' } }); // sin avisosChannel
    const guild = guildFake({ conAvisos: false });
    const client = clientFake(guild);

    const resultado = await vigilancia.vigilar(client);
    assert.ok(resultado.nuevos.some((x) => x.id.startsWith('voz-')));
    assert.equal(resultado.avisados, 0, 'no hay dónde avisar');

    const { problemas } = await vigilancia.revisar(client);
    assert.ok(
      problemas.some((x) => x.id.startsWith('voz-')),
      '/diag igual lo muestra'
    );
  });

  test('un fallo al enviar no tumba la vigilancia', async () => {
    reset();
    configurar({ voz: { hubId: 'hub-borrado' } });
    const guild = guildFake();
    guild.channels.cache.get('avisos-1').send = async () => {
      throw new Error('Falta de permisos');
    };

    const resultado = await vigilancia.vigilar(clientFake(guild));
    assert.ok(resultado.nuevos.length >= 1, 'el problema igual se detectó');
    assert.equal(resultado.avisados, 0, 'no se pudo avisar, pero no explotó');
  });
});

describe('/diag', () => {
  test('muestra los problemas con su acción recomendada', async () => {
    reset();
    configurar({ voz: { hubId: 'hub-borrado' } });
    const client = clientFake(guildFake());

    const vista = await diag.vistaDiag(client, client.guilds.cache.get(GUID), { ping: false });
    const embed = vista.embeds[0];
    const texto = JSON.stringify(embed.data);

    assert.match(embed.data.title, /Diagnóstico/);
    assert.match(texto, /Canales de voz temporales/, 'el problema aparece en el detalle');
    assert.match(texto, /Abrí `\/voz estado`/, 'dice qué hacer');
    assert.equal(embed.data.color, 0xed4245, 'rojo cuando hay errores');
    assert.equal(vista.components[0].components[0].data.custom_id, 'diag:refresh');
  });

  test('sin problemas queda en verde y explica qué revisó', async () => {
    reset();
    configurar();
    const client = clientFake(guildFake());

    const vista = await diag.vistaDiag(client, client.guilds.cache.get(GUID), { ping: false });
    const embed = vista.embeds[0];

    assert.match(embed.data.title, /todo en orden/i);
    assert.equal(embed.data.color, 0x57f287);
    assert.match(embed.data.description, /Revisé \*\*\d+ sistema/);
  });

  test('incluye el estado de los sistemas operativos', async () => {
    reset();
    configurar();
    const client = clientFake(guildFake());

    const vista = await diag.vistaDiag(client, client.guilds.cache.get(GUID), { ping: false });
    const campos = vista.embeds[0].data.fields;
    const nombres = campos.map((f) => f.name).join(' | ');
    const valores = campos.map((f) => f.value).join(' | ');

    assert.match(nombres, /IA/);
    assert.match(nombres, /Base de datos/);
    assert.match(nombres, /voz/i);
    assert.match(nombres, /Escrituras y proceso/);
    assert.match(nombres, /Búsqueda web/);
    assert.match(valores, /Presupuesto de hoy: \*\*\d+\/\d+\*\*/, 'el campo de IA muestra el presupuesto del día');
  });

  test('es un comando de staff', () => {
    const json = diag.data.toJSON();
    assert.equal(json.name, 'diag');
    assert.ok(json.default_member_permissions, '/diag tiene que declarar permisos');
    assert.equal(typeof diag.boton, 'function', 'el botón de refrescar existe');
  });
});
