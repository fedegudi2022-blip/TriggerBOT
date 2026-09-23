// Tests de /status (src/commands/status.js): el comando que mide todo el bot y lo
// muestra en un embed con botón de refrescar.
//
// Existe por un error que llegó a producción: /status nombraba a los proveedores con
// `ia.nombreProveedor()` sobre el ESTADO de la IA (el objeto que devuelve `estadoIA()`)
// en vez del módulo, y ningún test ejecutaba el comando. El caso que lo destapó fue
// justamente el nuevo: una cadena con más proveedores que Groq y Gemini.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-status-'));
process.env.GROQ_API_KEY = 'clave';
process.env.GEMINI_API_KEY = 'clave';

const status = require('../src/commands/status');
const ia = require('../src/utils/ia');
const busqueda = require('../src/utils/web');

after(() => {
  sinClavesIA();
  fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true });
});

// Las claves de IA se manejan por test para no depender de la máquina donde corre.
function sinClavesIA() {
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.MISTRAL_API_KEY;
}

function json(cuerpo, codigo = 200) {
  return { ok: codigo >= 200 && codigo < 300, status: codigo, json: async () => cuerpo, text: async () => JSON.stringify(cuerpo) };
}

// Sin red: /status lista modelos de cada proveedor con clave, así que el fetch devuelve
// el catálogo falso de cada uno (formato de la API de OpenAI; Gemini es el distinto).
const MODELOS = {
  'groq.com': ['openai/gpt-oss-120b'],
  'cerebras.ai': ['llama-3.3-70b'],
  'openrouter.ai': ['meta-llama/llama-3.3-70b-instruct:free'],
  'mistral.ai': ['mistral-small-latest'],
};

function instalarFetch() {
  global.fetch = async (url, opciones = {}) => {
    const u = String(url);
    if (u.includes('generativelanguage')) {
      return json({ models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] });
    }
    if (u.includes('chat/completions')) {
      const modelo = opciones.body ? JSON.parse(opciones.body).model : 'modelo';
      return json({ choices: [{ message: { content: `respuesta de ${modelo}` }, finish_reason: 'stop' }] });
    }
    const dominio = Object.keys(MODELOS).find((d) => u.includes(d));
    const ids = dominio ? MODELOS[dominio] : ['modelo'];
    return json({ data: ids.map((id) => ({ id })) });
  };
}

function clientFake() {
  return {
    ws: { ping: 42 },
    user: { displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/avatar.png' },
    commands: new Map([
      ['help', {}],
      ['status', {}],
    ]),
    guilds: { cache: new Map([['g1', {}]]) },
  };
}

// Corre el comando de punta a punta (medición + render) y devuelve lo que se muestra.
async function correr() {
  const client = clientFake();
  const m = await status.medir(client, null);
  const vista = status.vistaStatus(client, m);
  const campos = vista.embeds[0].data.fields;
  return { m, vista, campos, campo: (nombre) => campos.find((c) => c.name === nombre) };
}

describe('/status', () => {
  test('se rinde con la cadena completa y nombra a cada proveedor', async () => {
    sinClavesIA();
    process.env.GROQ_API_KEY = 'clave';
    process.env.GEMINI_API_KEY = 'clave';
    process.env.CEREBRAS_API_KEY = 'clave';
    instalarFetch();
    ia._internos.proveedoresPausados.clear();

    const { m, campos, campo } = await correr();

    // El bug que este test cubre: nombrar al proveedor desde el estado en vez del módulo.
    assert.ok(campo('🧠 Groq'), 'hay un chip por proveedor');
    assert.ok(campo('🧠 Cerebras'), 'los proveedores nuevos también aparecen');
    assert.ok(campo('🧠 Gemini'));
    assert.match(campo('🧠 Cerebras').value, /llama-3\.3-70b/, 'el chip dice el modelo en uso');
    assert.match(campo('⚡ Velocidad de la IA').value, /Cerebras/, 'y la velocidad se mide por proveedor');

    // El embed nunca puede pasarse del límite de campos de Discord.
    assert.ok(campos.length <= 25, `el embed tiene ${campos.length} campos`);
    assert.ok(!m.degradado, 'con todo sano el estado no queda degradado');
  });

  test('sin ninguna clave avisa que falta y no se rompe', async () => {
    sinClavesIA();
    instalarFetch();

    const { m, campo } = await correr();

    assert.match(campo('🧠 Groq').value, /sin clave/);
    assert.match(campo('🧠 Gemini').value, /sin clave/);
    assert.equal(m.degradado, true, 'sin IA el bot funciona, pero no está "todo en orden"');
  });

  test('un proveedor en pausa deja el estado general en degradado', async () => {
    sinClavesIA();
    process.env.GROQ_API_KEY = 'clave';
    process.env.CEREBRAS_API_KEY = 'clave';
    instalarFetch();
    ia._internos.proveedoresPausados.clear();
    ia._internos.pausarProveedor('cerebras', 60_000, 'la cuota está agotada');

    const { m, campo } = await correr();
    assert.equal(m.degradado, true);
    assert.match(campo('🧠 Cerebras').value, /en pausa/);
    assert.match(campo('🧠 Cerebras').value, /cuota/);
  });

  test('los contadores de respuestas se nombran por proveedor', async () => {
    sinClavesIA();
    process.env.CEREBRAS_API_KEY = 'clave';
    instalarFetch();
    // La búsqueda web no sale a internet: acá solo interesa la charla con IA.
    busqueda.reiniciar();
    busqueda.usarFetch(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }));
    ia._internos.proveedoresPausados.clear();
    // Se fuerza el camino del respaldo nuevo: sin Groq ni Gemini, contesta Cerebras y
    // el contador de ESE proveedor es el que después tiene que verse en /status.
    ia._internos.pausarProveedor('groq', 60_000, 'cuota agotada');
    ia._internos.pausarProveedor('gemini', 60_000, 'cuota agotada');

    const antes = ia.getStatsIA().cerebras ?? 0;
    await ia.conversar('u-status', 'que reglas tiene el server', { usuario: 'Fede' });
    assert.equal(ia.getStatsIA().cerebras, antes + 1, 'la respuesta salió por Cerebras');

    const { m, campo } = await correr();
    assert.match(campo('💬 Respuestas de IA').value, new RegExp(`Cerebras: \\*\\*${antes + 1}\\*\\*`));
    assert.match(m.statsIA, /Presupuesto de IA hoy/);
  });
});
