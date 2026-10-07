// Tests de los embeddings (src/utils/embeddings.js): la señal semántica del buscador.
//
// Cero red: el proveedor (Gemini) se reemplaza con usarFetch(). Lo que se protege es
// justamente lo que hace que esto no pueda romper el bot: sin clave (o con la clave rota)
// no se llama a nadie y se devuelve null, nunca una excepción; los vectores se guardan en
// disco para no volver a pagarlos en cada arranque; y un modelo que no existe se saltea.

const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Antes del require: la caché en disco vive en el directorio de datos (TRIGGER_DATA_DIR).
process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-emb-'));

const embeddings = require('../src/utils/embeddings');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

// ---------- Proveedor falso ----------
// Un vector por texto, derivado de una tabla de palabras clave: alcanza para probar la
// mecánica (lotes, caché, modelo alternativo, taskType) sin depender de la red.
function vectorDe(texto) {
  const t = String(texto).toLowerCase();
  if (/silencio|mensaje/.test(t)) return [1, 1, 0, 0];
  if (/mix|partida/.test(t)) return [0, 1, 0, 0];
  return [0, 0, 1, 0];
}

function respuestaOk(textos) {
  return { embeddings: textos.map((t) => ({ values: vectorDe(t) })) };
}

// Instala un fetch falso y devuelve el registro de llamadas (url + cuerpo parseado).
function proveedorFalso({ status = 200, cuerpo = null, error = null } = {}) {
  const llamadas = [];
  embeddings.usarFetch(async (url, opciones = {}) => {
    const peticion = opciones.body ? JSON.parse(opciones.body) : null;
    llamadas.push({ url: String(url), cuerpo: peticion });
    if (error) throw new Error(error);
    if (status !== 200) return { ok: false, status, json: async () => ({}), text: async () => '' };
    const textos = (peticion?.requests ?? []).map((r) => r.content.parts[0].text);
    return { ok: true, status: 200, json: async () => cuerpo ?? respuestaOk(textos), text: async () => '' };
  });
  return llamadas;
}

function limpiar() {
  process.env.GEMINI_API_KEY = 'clave-de-prueba';
  delete process.env.GEMINI_EMBED_MODEL;
  delete process.env.KB_SEMANTICO;
  fs.rmSync(embeddings.ARCHIVO, { force: true });
  embeddings.reiniciar();
}

beforeEach(limpiar);

describe('embeddings — sin proveedor no se llama a nadie', () => {
  test('sin clave de Gemini vectorizar devuelve null y no hay ninguna petición', async () => {
    const llamadas = proveedorFalso();
    delete process.env.GEMINI_API_KEY;

    assert.equal(embeddings.disponible(), false);
    assert.equal(await embeddings.vectorizar(['silencio']), null);
    assert.equal(llamadas.length, 0, 'sin clave no se sale a la red');
    assert.match(embeddings.estado().motivo, /sin clave de Gemini/);
  });

  test('con KB_SEMANTICO=off queda deshabilitada aunque haya clave', async () => {
    process.env.KB_SEMANTICO = 'off';
    const llamadas = proveedorFalso();

    assert.equal(embeddings.habilitado(), false);
    assert.equal(embeddings.disponible(), false);
    assert.equal(embeddings.estado().motivo, 'deshabilitada con KB_SEMANTICO');
    assert.equal(await embeddings.vectorizar(['silencio']), null);
    assert.equal(llamadas.length, 0);
  });

  test('una lista vacía no dispara nada y devuelve []', async () => {
    const llamadas = proveedorFalso();
    assert.deepEqual(await embeddings.vectorizar([]), []);
    assert.equal(llamadas.length, 0);
  });
});

describe('embeddings — lotes, caché y modelo', () => {
  test('manda un lote con el modelo por defecto y el taskType de documento', async () => {
    const llamadas = proveedorFalso();
    const vectores = await embeddings.vectorizar(['silencio', 'mix'], { tipo: 'documento' });

    assert.equal(llamadas.length, 1);
    assert.match(llamadas[0].url, /models\/gemini-embedding-001:batchEmbedContents/);
    assert.match(llamadas[0].url, /key=clave-de-prueba/);
    assert.equal(llamadas[0].cuerpo.requests.length, 2);
    assert.equal(llamadas[0].cuerpo.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
    assert.deepEqual(vectores, [
      [1, 1, 0, 0],
      [0, 1, 0, 0],
    ]);
  });

  test('la pregunta viaja con taskType de consulta (RETRIEVAL_QUERY)', async () => {
    const llamadas = proveedorFalso();
    await embeddings.vectorizar(['no me llegan los mensajes'], { tipo: 'consulta' });
    assert.equal(llamadas[0].cuerpo.requests[0].taskType, 'RETRIEVAL_QUERY');
  });

  test('parte en lotes de 50: 120 textos son 3 peticiones', async () => {
    const llamadas = proveedorFalso();
    const textos = Array.from({ length: 120 }, (_, i) => `texto ${i}`);
    const vectores = await embeddings.vectorizar(textos);

    assert.deepEqual(
      llamadas.map((l) => l.cuerpo.requests.length),
      [50, 50, 20]
    );
    assert.equal(vectores.length, 120);
    assert.equal(vectores[119].length, 4);
  });

  test('los vectores quedan cacheados en disco: un reinicio no los vuelve a pedir', async () => {
    const primeras = proveedorFalso();
    await embeddings.vectorizar(['silencio', 'mix']);
    assert.equal(primeras.length, 1);
    assert.ok(fs.existsSync(embeddings.ARCHIVO), 'se escribió la caché de embeddings');

    // Reinicio del bot: se va la caché en memoria y queda la de disco.
    embeddings.reiniciar();
    const segundas = proveedorFalso();
    const vectores = await embeddings.vectorizar(['silencio', 'mix']);

    assert.equal(segundas.length, 0, 'los vectores salieron del disco, sin red');
    assert.deepEqual(vectores, [
      [1, 1, 0, 0],
      [0, 1, 0, 0],
    ]);
  });

  test('un texto que cambió se vuelve a embeber (la clave es el contenido)', async () => {
    const llamadas = proveedorFalso();
    await embeddings.vectorizar(['silencio']);
    assert.equal(llamadas.length, 1);

    await embeddings.vectorizar(['silencio', 'mix']);
    assert.equal(llamadas.length, 2);
    assert.equal(llamadas[1].cuerpo.requests.length, 1, 'solo el texto nuevo');
  });

  test('estado() informa el modelo que funcionó y cuántos vectores hay', async () => {
    proveedorFalso();
    await embeddings.vectorizar(['silencio', 'mix']);

    const estado = embeddings.estado();
    assert.equal(estado.modelo, 'gemini-embedding-001');
    assert.equal(estado.documentos, 2);
    assert.equal(estado.disponible, true);
    assert.equal(estado.motivo, null);
  });
});

describe('embeddings — errores del proveedor (nunca explotan)', () => {
  test('un 429 castiga un minuto y no se reintenta en cada texto', async () => {
    const llamadas = proveedorFalso({ status: 429 });

    assert.equal(await embeddings.vectorizar(['silencio']), null);
    const estado = embeddings.estado();
    assert.equal(estado.disponible, false);
    assert.match(estado.motivo, /cuota agotada/);
    assert.ok(estado.recuperaEnMs > 30_000 && estado.recuperaEnMs <= 60_000, `faltan ${estado.recuperaEnMs} ms`);

    assert.equal(await embeddings.vectorizar(['otro texto']), null);
    assert.equal(llamadas.length, 1, 'el castigo evita el viaje de red repetido');
  });

  test('un 401 aparta la clave una hora', async () => {
    proveedorFalso({ status: 401 });
    assert.equal(await embeddings.vectorizar(['silencio']), null);

    const estado = embeddings.estado();
    assert.match(estado.motivo, /clave inválida/);
    assert.ok(estado.recuperaEnMs > 50 * 60 * 1000, `faltan ${estado.recuperaEnMs} ms`);
  });

  test('sin salida a internet devuelve null y lo deja anotado', async () => {
    proveedorFalso({ error: 'getaddrinfo ENOTFOUND generativelanguage.googleapis.com' });

    assert.equal(await embeddings.vectorizar(['silencio']), null);
    assert.match(embeddings.estado().motivo, /sin respuesta del proveedor/);
  });

  test('una respuesta con menos embeddings que textos también se degrada', async () => {
    proveedorFalso({ cuerpo: { embeddings: [] } });

    assert.equal(await embeddings.vectorizar(['silencio', 'mix']), null);
    assert.match(embeddings.estado().motivo, /respuesta inesperada/);
  });

  test('un modelo inexistente (404) salta al siguiente de la lista', async () => {
    const urls = [];
    let llamadas = 0;
    embeddings.usarFetch(async (url, opciones = {}) => {
      urls.push(String(url));
      llamadas += 1;
      if (llamadas === 1) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      const peticion = JSON.parse(opciones.body);
      return { ok: true, status: 200, json: async () => respuestaOk(peticion.requests.map((r) => r.content.parts[0].text)), text: async () => '' };
    });

    const vectores = await embeddings.vectorizar(['silencio']);
    assert.deepEqual(vectores, [[1, 1, 0, 0]]);
    assert.match(urls[0], /models\/gemini-embedding-001:/);
    assert.match(urls[1], /models\/text-embedding-004:/);
    assert.equal(embeddings.estado().modelo, 'text-embedding-004');
  });

  test('un modelo forzado por entorno no salta a otro nombre', async () => {
    process.env.GEMINI_EMBED_MODEL = 'mi-modelo';
    const llamadas = proveedorFalso({ status: 404 });

    assert.equal(await embeddings.vectorizar(['silencio']), null);
    assert.equal(llamadas.length, 1, 'no prueba nombres que nadie pidió');
    assert.match(llamadas[0].url, /models\/mi-modelo:batchEmbedContents/);
  });

  test('si el modelo no acepta taskType se reintenta sin él y no se vuelve a mandar', async () => {
    const cuerpos = [];
    let llamadas = 0;
    embeddings.usarFetch(async (url, opciones = {}) => {
      const peticion = JSON.parse(opciones.body);
      cuerpos.push(peticion);
      llamadas += 1;
      if (llamadas === 1) return { ok: false, status: 400, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => respuestaOk(peticion.requests.map((r) => r.content.parts[0].text)), text: async () => '' };
    });

    assert.deepEqual(await embeddings.vectorizar(['silencio']), [[1, 1, 0, 0]]);
    assert.ok(cuerpos[0].requests[0].taskType, 'el primer intento lo manda');
    assert.equal(cuerpos[1].requests[0].taskType, undefined, 'el reintento va sin taskType');

    await embeddings.vectorizar(['mix']);
    assert.equal(cuerpos.at(-1).requests[0].taskType, undefined, 'queda recordado');
    assert.equal(llamadas, 3);
  });
});

describe('embeddings — similitud coseno', () => {
  test('vectores iguales dan 1 y perpendiculares dan 0', () => {
    assert.equal(embeddings.similitud([1, 0], [1, 0]), 1);
    assert.equal(embeddings.similitud([1, 0], [0, 1]), 0);
  });

  test('un vector a medio camino da su coseno real', () => {
    assert.ok(Math.abs(embeddings.similitud([1, 1, 0], [1, 0, 0]) - Math.SQRT1_2) < 1e-9);
  });

  test('entradas inválidas dan 0 en vez de romper', () => {
    assert.equal(embeddings.similitud(null, [1, 0]), 0);
    assert.equal(embeddings.similitud([1, 0], [1, 0, 0]), 0, 'dimensiones distintas no son comparables');
    assert.equal(embeddings.similitud([0, 0], [1, 0]), 0);
    assert.equal(embeddings.similitud([], []), 0);
  });

  test('la clave de la caché depende del texto entero', () => {
    assert.equal(embeddings.hashDe('hola'), embeddings.hashDe('hola'));
    assert.notEqual(embeddings.hashDe('hola'), embeddings.hashDe('hola '));
    assert.notEqual(embeddings.hashDe('hola'), embeddings.hashDe('holaa'));
  });
});
