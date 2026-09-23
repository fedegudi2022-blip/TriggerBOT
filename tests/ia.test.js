// Tests del motor de IA (utils/ia.js) con fetch mockeado: cero red.
// Cubren el armado del prompt (contexto en vivo + base de conocimiento), los perfiles
// de respuesta, el troceo de mensajes largos, el reintento por truncado, la cadena
// Groq → Gemini → repertorio local y la detección de acciones de moderación.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-ia-'));
process.env.GROQ_API_KEY = 'clave-de-prueba';
process.env.GEMINI_API_KEY = 'clave-de-prueba';

const ia = require('../src/utils/ia');
const contexto = require('../src/utils/contexto');
const conocimiento = require('../src/utils/conocimiento');
const niveles = require('../src/niveles');
const store = require('../src/store');
const monitoreo = require('../src/utils/monitoreo');

const { trocearMensaje, perfilDe, sistemaCompleto, conversar, esMensajeSimple } = ia;

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

const GUILD_ID = 'g-ia-1';

// ---------- Mock de fetch ----------
const LLAMADAS = [];

function json(cuerpo, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => cuerpo,
    text: async () => JSON.stringify(cuerpo),
  };
}

// `chat(cuerpo, numero)` decide la respuesta de cada llamada de generación.
// `fallar` fuerza un error HTTP por proveedor ('groq' | 'gemini').
function instalarFetch({ chat, fallar } = {}) {
  LLAMADAS.length = 0;
  let generaciones = 0;

  global.fetch = async (url, opciones = {}) => {
    const u = String(url);
    const cuerpo = opciones.body ? JSON.parse(opciones.body) : null;
    const agente = u.includes('groq.com') ? 'groq' : 'gemini';
    const esGeneracion = u.includes('generateContent') || u.includes('chat/completions');

    LLAMADAS.push({ url: u, agente, esGeneracion, cuerpo, headers: opciones.headers ?? {} });

    if (!esGeneracion) {
      // Listado de modelos.
      return agente === 'groq'
        ? json({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'llama-3.1-8b-instant' }] })
        : json({ models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] });
    }

    if (fallar === agente) return json({ error: { message: 'boom' } }, 500);

    generaciones += 1;
    const r = chat ? chat(cuerpo, generaciones) : {};
    const titulo = r?.texto ?? `respuesta de ${agente}`;

    return agente === 'groq'
      ? json({ choices: [{ message: { content: titulo }, finish_reason: r?.finish ?? 'stop' }] })
      : json({ candidates: [{ content: { parts: [{ text: titulo }] }, finishReason: r?.finishGemini ?? 'STOP' }] });
  };
}

const generacionesDe = (agente) => LLAMADAS.filter((l) => l.esGeneracion && l.agente === agente);

// ---------- Fakes de Discord ----------
function clientFake() {
  return {
    commands: new Map([
      ['help', { data: { name: 'help', description: 'Muestra la guía de comandos' } }],
      ['ban', { data: { name: 'ban', description: 'Banea a un usuario' } }],
      ['estadisticas', { data: { name: 'estadisticas', description: 'Tu XP, nivel y racha' } }],
    ]),
  };
}

function miembroFake(id, { displayName = 'Fede', dueno = false } = {}) {
  return {
    id,
    displayName,
    user: { id, username: displayName },
    roles: { cache: new Map() },
    permissions: { has: () => false },
    communicationDisabledUntilTimestamp: null,
    esDueno: dueno,
  };
}

function guildFake(id, { ownerId = 'otro' } = {}) {
  return {
    id,
    name: 'TriGGer.Arena',
    ownerId,
    memberCount: 312,
    members: { cache: new Map() },
    channels: { cache: new Map() },
  };
}

describe('perfilDe — charla vs consulta', () => {
  test('saludos y bromas → charla (modelo chico, temperatura alta)', () => {
    for (const m of ['hola', 'jajaja', 'buenísimo', 'todo bien', 'gracias!']) {
      assert.equal(perfilDe(m), 'charla', `"${m}" debería ser charla`);
    }
  });

  test('preguntas, comandos y pedidos → consulta (preciso)', () => {
    for (const m of [
      '¿cuántos jugadores hay en el mix?',
      'como configuro el modlog',
      'que reglas tiene el server',
      'me ayudas con /help',
      'muteá a fulano por flodeo',
    ]) {
      assert.equal(perfilDe(m), 'consulta', `"${m}" debería ser consulta`);
    }
  });

  test('un mensaje largo es consulta aunque no tenga signos', () => {
    assert.equal(perfilDe('a'.repeat(120)), 'consulta');
  });

  test('sigue existiendo el enrutado al modelo chico para charla simple', () => {
    assert.ok(esMensajeSimple('hola'));
    assert.equal(perfilDe('hola'), 'charla');
  });
});

describe('trocearMensaje — respuestas largas', () => {
  test('un texto corto queda en un solo mensaje', () => {
    assert.deepEqual(trocearMensaje('Hola, ¿todo bien?'), ['Hola, ¿todo bien?']);
    assert.deepEqual(trocearMensaje(''), []);
    assert.deepEqual(trocearMensaje(null), []);
  });

  test('parte respetando párrafos y no pierde ni un carácter', () => {
    const parrafo = 'La comunidad tiene servidores públicos y de mix. '.repeat(20); // ~1.000 caracteres
    const texto = `${parrafo}\n\n${parrafo}\n\n${parrafo}`; // ~3.000 caracteres
    const trozos = trocearMensaje(texto);

    assert.ok(trozos.length >= 2, 'debería partirse');
    for (const t of trozos) assert.ok(t.length <= 2000, `trozo de ${t.length}`);
    assert.equal(
      trozos.join('').replace(/\s+/g, ''),
      texto.replace(/\s+/g, ''),
      'no se puede perder contenido en el corte'
    );
  });

  test('corta en el límite cuando no hay dónde cortar (palabra gigante)', () => {
    const trozos = trocearMensaje('x'.repeat(4500));
    assert.equal(trozos.length, 3);
    assert.equal(trozos.join('').length, 4500);
  });
});

describe('sistemaCompleto — armado del prompt', () => {
  test('incluye identidad, reglas de precisión y los dos bloques de datos', () => {
    const sistema = sistemaCompleto({
      usuario: 'Fede',
      canal: 'general',
      perfil: 'consulta',
      vivo: 'Servidor: TriGGer.Arena — 312 miembros.',
      conocimiento: '### Cómo entro a un servidor\nUsá connect IP en la consola.',
    });

    assert.match(sistema, /TriggerBOT/);
    assert.match(sistema, /REGLAS DE PRECISIÓN/);
    assert.match(sistema, /INFORMACIÓN DEL SERVIDOR/);
    assert.match(sistema, /312 miembros/);
    assert.match(sistema, /connect IP/);
    assert.match(sistema, /"accion"/, 'mantiene el detector de acciones de moderación');
    assert.match(sistema, /hoy es .*hora de Argentina/);
  });

  test('avisa explícitamente cuando no hay conocimiento cargado', () => {
    const sistema = sistemaCompleto({ perfil: 'consulta', vivo: '', conocimiento: '' });
    assert.match(sistema, /no encontré nada cargado sobre este tema/i);
  });

  test('el estilo depende del perfil', () => {
    assert.match(sistemaCompleto({ perfil: 'charla' }), /Estilo de esta respuesta: breve/);
    assert.match(sistemaCompleto({ perfil: 'consulta' }), /Estilo de esta respuesta: completa/);
  });
});

describe('contexto en vivo', () => {
  test('catalogoComandos usa los comandos reales y marca los de staff', () => {
    const catalogo = contexto.catalogoComandos(clientFake());
    assert.match(catalogo, /Comandos \(3/);
    assert.match(catalogo, /\/ban \(solo staff\): Banea a un usuario/);
    assert.match(catalogo, /\/estadisticas: Tu XP, nivel y racha/);
  });

  test('el catálogo corto solo lista nombres (perfil charla)', () => {
    const catalogo = contexto.catalogoComandos(clientFake(), { detallado: false });
    assert.match(catalogo, /\/ban \(solo staff\)/);
    assert.ok(!catalogo.includes('Banea a un usuario'));
  });

  test('ficha del autor: nivel, XP, puesto y advertencias', () => {
    const guild = guildFake(GUILD_ID);
    const miembro = miembroFake('100000000000000009');
    niveles.procesarMensaje(GUILD_ID, miembro.id);

    const ficha = contexto.fichaUsuario(guild, miembro);
    assert.match(ficha, /Quien escribe: Fede/);
    assert.match(ficha, /nivel \d+ \(/);
    assert.match(ficha, /XP/);
    assert.match(ficha, /puesto \d+ de \d+/);
  });

  test('reconoce al dueño del servidor', () => {
    const guild = guildFake(GUILD_ID, { ownerId: '1' });
    const ficha = contexto.fichaUsuario(guild, miembroFake('1'));
    assert.match(ficha, /DUEÑO del servidor/);
  });

  test('estado de los servidores CS desde la cache del monitoreo', () => {
    store.escribir('g-ia-cs', { servidores: { lista: [{ nombre: 'PUBLICO', host: '1.2.3.4', puerto: 27015 }] } });
    monitoreo.cache.set('1.2.3.4:27015', {
      ok: true,
      datos: { jugadores: 12, maximo: 32, mapa: 'de_dust2' },
      cuando: Date.now(),
    });

    const texto = contexto.estadoServidores({ id: 'g-ia-cs' });
    assert.match(texto, /PUBLICO: 12\/32 jugadores en de_dust2/);
  });

  test('construirContextoVivo arma el bloque completo', () => {
    const guild = guildFake(GUILD_ID);
    const vivo = contexto.construirContextoVivo({
      client: clientFake(),
      guild,
      member: miembroFake('100000000000000010'),
      canal: { name: 'general' },
    });

    assert.match(vivo, /Servidor: TriGGer\.Arena — 312 miembros/);
    assert.match(vivo, /Canal: #general/);
    assert.match(vivo, /Comandos \(3/);
  });

  test('sin guild no rompe', () => {
    assert.equal(contexto.construirContextoVivo({}), '');
  });
});

describe('conversar — cadena de proveedores', () => {
  test('Groq responde y el prompt sale con datos vivos y conocimiento', async () => {
    instalarFetch({ chat: () => ({ texto: 'Escribí connect IP en la consola.' }) });

    const guild = guildFake(GUILD_ID);
    const respuesta = await conversar('u-conocimiento', 'como entro al servidor de cs 1.6', {
      usuario: 'Fede',
      canal: 'general',
      guild,
      miembro: miembroFake('100000000000000011'),
      client: clientFake(),
    });

    assert.equal(respuesta.tipo, 'chat');
    assert.equal(respuesta.texto, 'Escribí connect IP en la consola.');

    const [generacion] = generacionesDe('groq');
    assert.ok(generacion, 'debería haber llamado a Groq');
    const sistema = generacion.cuerpo.messages[0].content;
    assert.equal(generacion.cuerpo.messages[0].role, 'system');
    assert.match(sistema, /REGLAS DE PRECISIÓN/);
    assert.match(sistema, /Servidor: TriGGer\.Arena/);
    assert.match(sistema, /\/ban \(solo staff\)/, 'el catálogo real viaja en el prompt');
    assert.match(sistema, /connect IP/, 'la base de conocimiento viaja en el prompt');
    assert.match(sistema, /Estilo de esta respuesta: completa/, 'una pregunta usa el perfil consulta');
    assert.equal(generacion.cuerpo.temperature, ia.PERFILES.consulta.temperature);
    assert.equal(generacion.cuerpo.messages.at(-1).content, 'como entro al servidor de cs 1.6');
  });

  test('charla simple: perfil charla, modelo chico y temperatura alta', async () => {
    instalarFetch({ chat: () => ({ texto: '¡Todo bien! ¿Vos?' }) });

    const respuesta = await conversar('u-charla', 'hola', { usuario: 'Fede', canal: 'general' });
    assert.equal(respuesta.tipo, 'chat');

    const [generacion] = generacionesDe('groq');
    assert.equal(generacion.cuerpo.model, ia.GROQ_RAPIDO, 'la charla social usa el modelo chico');
    assert.equal(generacion.cuerpo.temperature, ia.PERFILES.charla.temperature);
    assert.match(generacion.cuerpo.messages[0].content, /Estilo de esta respuesta: breve/);
  });

  test('detecta un pedido de moderación y lo devuelve como acción', async () => {
    instalarFetch({
      chat: () => ({
        texto: '{"accion":"mute","objetivo":"fulano","motivo":"flood","duracion_min":60}',
      }),
    });

    const respuesta = await conversar('u-accion', 'muteá a fulano por flood', { usuario: 'Fede' });
    assert.equal(respuesta.tipo, 'accion');
    assert.equal(respuesta.accion, 'mute');
    assert.equal(respuesta.objetivo, 'fulano');
    assert.equal(respuesta.motivo, 'flood');
  });

  test('una respuesta con llaves pero sin acción válida se trata como chat', async () => {
    instalarFetch({ chat: () => ({ texto: 'Para moderar usá {"ejemplo": "de json"} en la doc.' }) });
    const respuesta = await conversar('u-json-raro', 'como modero', { usuario: 'Fede' });
    assert.equal(respuesta.tipo, 'chat');
    assert.match(respuesta.texto, /ejemplo/);
  });

  test('respuesta cortada por tokens: reintenta con más margen', async () => {
    instalarFetch({
      chat: (cuerpo, n) =>
        n === 1 ? { texto: 'Respuesta a medias', finish: 'length' } : { texto: 'Respuesta completa', finish: 'stop' },
    });

    const respuesta = await conversar('u-truncado', '¿me explicás el sistema de logros completo?', { usuario: 'Fede' });
    assert.equal(respuesta.texto, 'Respuesta completa');

    const [primera, segunda] = generacionesDe('groq');
    assert.ok(segunda, 'debería haber un segundo intento');
    assert.equal(primera.cuerpo.max_tokens, ia.PERFILES.consulta.maxTokens);
    assert.ok(segunda.cuerpo.max_tokens > primera.cuerpo.max_tokens, 'el reintento pide más tokens');
  });

  test('si Groq falla, responde Gemini', async () => {
    instalarFetch({ fallar: 'groq', chat: () => ({ texto: 'Respuesta de respaldo' }) });
    const antes = ia.getStatsIA().gemini;

    const respuesta = await conversar('u-fallback', 'que reglas tiene el server', { usuario: 'Fede' });
    assert.equal(respuesta.texto, 'Respuesta de respaldo');
    assert.ok(generacionesDe('gemini').length >= 1);
    assert.ok(ia.getStatsIA().gemini > antes);
  });

  test('si los dos fallan, devuelve null y el bot usa su repertorio local', async () => {
    instalarFetch({ fallar: 'groq' });
    const originalFetch = global.fetch;
    const sinGemini = async (url, opciones) => {
      if (String(url).includes('generateContent')) throw new Error('gemini caído');
      return originalFetch(url, opciones);
    };
    global.fetch = sinGemini;

    const respuesta = await conversar('u-todo-caido', 'cuantos jugadores hay?', { usuario: 'Fede' });
    assert.equal(respuesta, null);
  });

  test('la memoria de conversación incluye los turnos anteriores', async () => {
    instalarFetch({ chat: () => ({ texto: 'Anotado.' }) });
    await conversar('u-memoria', 'me llamo Fede', { usuario: 'Fede' });
    await conversar('u-memoria', 'y ahora?', { usuario: 'Fede' });

    const ultima = generacionesDe('groq').at(-1);
    const papeles = ultima.cuerpo.messages.map((m) => m.role);
    assert.deepEqual(papeles, ['system', 'user', 'assistant', 'user']);
  });
});

describe('base de conocimiento integrada en el prompt', () => {
  test('una pregunta de normas viaja con la norma correcta en el prompt', async () => {
    instalarFetch({ chat: () => ({ texto: 'No se permite sin autorización del staff.' }) });
    await conversar('u-reglas', 'puedo publicar mi discord en el chat?', { usuario: 'Fede' });

    const sistema = generacionesDe('groq')[0].cuerpo.messages[0].content;
    assert.match(sistema, /Norma 3 — Spam, flood y publicidad/);
    assert.match(sistema, /sin autorización previa del staff/i);
  });

  test('sin coincidencias el prompt lo dice (el bot no debe inventar)', async () => {
    instalarFetch({ chat: () => ({ texto: 'No tengo esa info.' }) });
    await conversar('u-sin-info', 'cuanto cuesta la pizza de muzzarella', { usuario: 'Fede' });

    const sistema = generacionesDe('groq')[0].cuerpo.messages[0].content;
    assert.match(sistema, /no encontré nada cargado sobre este tema/i);
  });

  test('la base real tiene contenido (si no, la IA respondería a ciegas)', () => {
    const stats = conocimiento.estadisticas(conocimiento.DIRECTORIO_POR_DEFECTO);
    assert.ok(stats.secciones > 0, 'docs/conocimiento debe estar cargada');
    assert.ok(stats.archivos.length >= 5);
  });
});
