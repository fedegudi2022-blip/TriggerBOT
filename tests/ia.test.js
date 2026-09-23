// Tests del motor de IA (utils/ia.js) con fetch mockeado: cero red.
// Cubren el armado del prompt (contexto en vivo + base de conocimiento), los perfiles
// de respuesta, el troceo de mensajes largos, el reintento por truncado, la cadena
// Groq → Gemini → repertorio local y la detección de acciones de moderación.

const { test, describe, after, beforeEach } = require('node:test');
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
const busqueda = require('../src/utils/web');
const presupuesto = require('../src/utils/presupuesto');
const niveles = require('../src/niveles');
const store = require('../src/store');
const monitoreo = require('../src/utils/monitoreo');

const { trocearMensaje, perfilDe, sistemaCompleto, conversar, esMensajeSimple } = ia;

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

// Estos tests no salen a internet: la búsqueda web arranca con un fetch que dice "no
// hay nada" y cada test que la necesita lo reemplaza por un fake propio. El camino de
// búsqueda tiene sus propios tests (tests/web.test.js).
const SIN_RED = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

beforeEach(() => {
  busqueda.reiniciar();
  busqueda.usarFetch(SIN_RED);
});

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
      // Listado de modelos: refleja el catálogo real del plan gratuito de Groq
      // (agosto 2026: la familia llama pasó a Enterprise y quedaron los GPT-OSS).
      return agente === 'groq'
        ? json({
            data: [
              { id: 'openai/gpt-oss-120b' },
              { id: 'openai/gpt-oss-20b' },
              { id: 'llama-3.3-70b-versatile' },
              { id: 'whisper-large-v3' },
              { id: 'meta-llama/llama-prompt-guard-2-22m' },
            ],
          })
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
    assert.equal(trozos.join('').replace(/\s+/g, ''), texto.replace(/\s+/g, ''), 'no se puede perder contenido en el corte');
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

    // El nombre de marca no se fija acá (puede cambiar): lo que importa es que el
    // bloque de identidad esté y que el bot siga sabiendo que es de Trigger.Arena.
    assert.match(sistema, /bot de moderación del servidor de Discord Trigger/);
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

  test('una orden sobre el canal se devuelve como acción, sin objetivo', async () => {
    instalarFetch({ chat: () => ({ texto: '{"accion":"limpiar","cantidad":500,"motivo":"ruido"}' }) });

    const respuesta = await conversar('u-limpiar', 'borra todos los mensajes de este canal', { usuario: 'Fede' });

    assert.equal(respuesta.tipo, 'accion');
    assert.equal(respuesta.accion, 'limpiar');
    assert.equal(respuesta.objetivo, '', 'no hay objetivo: la orden es sobre el canal');
    assert.equal(respuesta.cantidad, 100, 'la cantidad se acota al tope de Discord');
  });

  test('slowmode: los segundos vienen del modelo y se acotan al máximo de Discord', async () => {
    instalarFetch({ chat: () => ({ texto: '{"accion":"slowmode","segundos":999999}' }) });

    const respuesta = await conversar('u-slowmode', 'pone modo lento en este canal', { usuario: 'Fede' });
    assert.equal(respuesta.accion, 'slowmode');
    assert.equal(respuesta.segundos, 21600, '6 horas: el máximo que acepta Discord');
  });

  test('una orden de moderación sin objetivo se trata como chat (no se inventa a quién)', async () => {
    instalarFetch({ chat: () => ({ texto: '{"accion":"ban","motivo":"flood"}' }) });

    const respuesta = await conversar('u-sin-objetivo', 'banea a alguien del canal', { usuario: 'Fede' });
    assert.equal(respuesta.tipo, 'chat');
  });

  test('una acción inventada por el modelo no se ejecuta', async () => {
    instalarFetch({ chat: () => ({ texto: '{"accion":"borrar_todo_el_servidor"}' }) });

    const respuesta = await conversar('u-accion-inventada', 'borra el servidor entero', { usuario: 'Fede' });
    assert.equal(respuesta.tipo, 'chat', 'la lista blanca vale más que lo que devuelva el modelo');
  });

  test('el prompt le prohíbe a la IA negarse cuando la orden viene del staff', () => {
    const sistema = sistemaCompleto({ perfil: 'consulta' });
    // El caso real: "borrá todos los mensajes de este canal" contestado con "no tengo
    // permiso para borrar mensajes". El contrato tiene que incluir las órdenes de canal
    // y decir explícitamente que el staff no recibe negativas.
    assert.match(sistema, /"limpiar"/, 'el contrato incluye las órdenes sobre el canal');
    assert.match(sistema, /"slowmode"/);
    assert.match(sistema, /NUNCA contestes que no pod[eé]s/);
    assert.match(sistema, /solo el staff puede pedirlo/, 'y qué contestar cuando no es staff');
  });

  test('una respuesta con llaves pero sin acción válida se trata como chat', async () => {
    instalarFetch({ chat: () => ({ texto: 'Para moderar usá {"ejemplo": "de json"} en la doc.' }) });
    const respuesta = await conversar('u-json-raro', 'como modero', { usuario: 'Fede' });
    assert.equal(respuesta.tipo, 'chat');
    assert.match(respuesta.texto, /ejemplo/);
  });

  test('respuesta cortada por tokens: reintenta con más margen', async () => {
    instalarFetch({
      chat: (cuerpo, n) => (n === 1 ? { texto: 'Respuesta a medias', finish: 'length' } : { texto: 'Respuesta completa', finish: 'stop' }),
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

  test('sin coincidencias el prompt lo dice (el bot no debe inventar)', () => {
    const sistema = sistemaCompleto({
      perfil: 'consulta',
      vivo: '',
      conocimiento: '',
      conocimientoVacio: '',
    });
    assert.match(sistema, /no encontré nada cargado sobre este tema/i);
  });

  test('una pregunta que no es de la comunidad no arrastra la base del server', async () => {
    instalarFetch({ chat: () => ({ texto: 'Depende de la pizzería.' }) });
    await conversar('u-sin-info', 'cuanto cuesta la pizza de muzzarella', { usuario: 'Fede' });

    const sistema = generacionesDe('groq')[0].cuerpo.messages[0].content;
    assert.match(sistema, /la base del servidor no aplica/i, 'el prompt lo aclara');
    assert.doesNotMatch(sistema, /^### /m, 'ni una sección de la comunidad en el prompt');
    assert.doesNotMatch(sistema, /no encontré nada cargado sobre este tema/i);
  });

  test('la base real tiene contenido (si no, la IA respondería a ciegas)', () => {
    const stats = conocimiento.estadisticas(conocimiento.DIRECTORIO_POR_DEFECTO);
    assert.ok(stats.secciones > 0, 'docs/conocimiento debe estar cargada');
    assert.ok(stats.archivos.length >= 5);
  });
});

// ---------- Conocimiento general + búsqueda web ----------
//
// El caso que originó todo esto: "@Trigger messi cuantos años tiene" terminaba en
// "eso no lo tengo cargado, abrí un ticket". Las reglas de precisión valen para los
// datos del server; para el resto el bot responde con lo que sabe y, si no sabe,
// busca en la web (utils/web.js) y contesta igual.
describe('conocimiento general y búsqueda web', () => {
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

  // Wikipedia responde; las otras fuentes quedan caídas (lo normal cuando una de las
  // dos anda: el módulo se queda con lo que llegue).
  function conWikipedia() {
    busqueda.reiniciar();
    busqueda.usarFetch(async (url) =>
      String(url).includes('wikipedia.org') ? { ok: true, status: 200, json: async () => WIKI, text: async () => '' } : SIN_RED()
    );
  }

  test('el prompt separa los datos de la comunidad del conocimiento general', () => {
    const sistema = sistemaCompleto({ perfil: 'consulta', vivo: '', conocimiento: '' });
    assert.match(sistema, /CONOCIMIENTO GENERAL/);
    assert.match(sistema, /una pregunta de cultura general/);
    assert.match(sistema, /INFORMACIÓN DEL SERVIDOR/);
  });

  test('los resultados de búsqueda web entran al prompt como fuente principal', () => {
    const sistema = sistemaCompleto({
      perfil: 'consulta',
      vivo: '',
      conocimiento: '',
      web: '- [Wikipedia] Lionel Messi: nació el 24 de junio de 1987.',
    });
    assert.match(sistema, /--- RESULTADOS DE BÚSQUEDA WEB/);
    assert.match(sistema, /24 de junio de 1987/);
    assert.match(sistema, /INFORMACIÓN DEL SERVIDOR/);
  });

  test('rescate: si la IA dice que no sabe, busca y contesta con lo que encontró', async () => {
    instalarFetch({
      chat: (cuerpo, n) =>
        n === 1
          ? { texto: 'Eso no lo tengo cargado. Podés usar /help o abrir un ticket de soporte.' }
          : { texto: 'Nació el 24 de junio de 1987, así que tiene 39 años.' },
    });
    conWikipedia();
    const webAntes = ia.getStatsIA().web;

    const respuesta = await conversar('u-web-rescate', 'messi cuantos anios tiene', { usuario: 'Fede' });
    assert.equal(respuesta.tipo, 'chat');
    assert.match(respuesta.texto, /39 años/);

    const generaciones = generacionesDe('groq');
    assert.equal(generaciones.length, 2, 'hay un segundo intento con los resultados de la búsqueda');
    assert.doesNotMatch(
      generaciones[0].cuerpo.messages[0].content,
      /--- RESULTADOS DE BÚSQUEDA WEB/,
      'la primera respuesta se intenta sin búsqueda: no se busca de gusto'
    );
    assert.match(generaciones[1].cuerpo.messages[0].content, /--- RESULTADOS DE BÚSQUEDA WEB/);
    assert.match(generaciones[1].cuerpo.messages[0].content, /24 de junio de 1987/);
    assert.ok(ia.getStatsIA().web > webAntes, 'la búsqueda usada queda contada para /status');
  });

  test('pedido explícito: se busca antes de responder, en un solo intento de IA', async () => {
    instalarFetch({ chat: () => ({ texto: 'San Martín fue un militar argentino.' }) });
    conWikipedia();

    const respuesta = await conversar('u-web-forzada', 'buscame quien fue san martin', { usuario: 'Fede' });
    assert.match(respuesta.texto, /^San Martín fue un militar argentino\./);
    assert.match(respuesta.texto, /🔎 Fuentes: \[Wikipedia\]\(https:\/\/es\.wikipedia\.org\/wiki\/Lionel_Messi\)/, 'cita la fuente');

    const generaciones = generacionesDe('groq');
    assert.equal(generaciones.length, 1);
    assert.match(generaciones[0].cuerpo.messages[0].content, /--- RESULTADOS DE BÚSQUEDA WEB/);
    assert.match(generaciones[0].cuerpo.messages[0].content, /Lionel Messi/);
  });

  test('no repite el pie de fuentes si el modelo ya citó el link', () => {
    const { conFuentes } = ia._internos;
    const resultados = [{ fuente: 'Wikipedia', titulo: 'Messi', texto: 'x', url: 'https://es.wikipedia.org/wiki/Lionel_Messi' }];

    assert.match(conFuentes('Nació en 1987.', resultados), /🔎 Fuentes: \[Wikipedia\]/);
    assert.equal(
      conFuentes('Nació en 1987 (https://es.wikipedia.org/wiki/Lionel_Messi).', resultados),
      'Nació en 1987 (https://es.wikipedia.org/wiki/Lionel_Messi).',
      'si el link ya está en el texto, no se agrega nada'
    );
    assert.equal(conFuentes('Nació en 1987.', []), 'Nació en 1987.');
  });

  test('una pregunta de la comunidad nunca dispara la búsqueda web', async () => {
    instalarFetch({ chat: () => ({ texto: 'No tengo esa info.' }) });
    conWikipedia();
    const webAntes = ia.getStatsIA().web;

    const respuesta = await conversar('u-web-comunidad', 'que reglas tiene el server', { usuario: 'Fede' });
    assert.equal(respuesta.texto, 'No tengo esa info.');
    assert.equal(generacionesDe('groq').length, 1, 'sin segundo intento: internet no sabe las reglas del server');
    assert.equal(ia.getStatsIA().web, webAntes);
  });
});

// ---------- Caché de respuestas y presupuesto diario ----------
// Las dos existen por el mismo motivo: no gastar cuota de IA al pedo. La caché, cuando
// alguien repite la misma pregunta; el presupuesto, cuando el día ya gastó demasiado.
describe('caché de respuestas y presupuesto de IA', () => {
  const GUILD = 'g-ia-cache';

  function contextoGuild(miembroId) {
    return { usuario: 'Fede', canal: 'general', guild: guildFake(GUILD), miembro: miembroFake(miembroId), client: clientFake() };
  }

  test('una pregunta general repetida se sirve de la caché (sin gastar otra llamada)', async () => {
    instalarFetch({ chat: () => ({ texto: 'Messi nació en 1987.' }) });
    ia._internos.cacheRespuestas.clear();
    const antes = ia.getStatsIA().cache;

    const primera = await conversar('u-cache', 'quien es lionel messi', contextoGuild('100000000000000020'));
    const segunda = await conversar('u-cache', 'quien es lionel messi', contextoGuild('100000000000000020'));

    assert.equal(primera.texto, 'Messi nació en 1987.');
    assert.equal(segunda.texto, primera.texto);
    assert.equal(generacionesDe('groq').length, 1, 'la segunda sale de la caché: una sola llamada al modelo');
    assert.equal(ia.getStatsIA().cache, antes + 1);
  });

  test('la caché es por usuario: la respuesta no se le sirve a otro', async () => {
    instalarFetch({ chat: () => ({ texto: 'Respuesta personalizada.' }) });
    ia._internos.cacheRespuestas.clear();

    await conversar('u-cache-a', 'quien es lionel messi', contextoGuild('100000000000000021'));
    await conversar('u-cache-b', 'quien es lionel messi', contextoGuild('100000000000000022'));

    assert.equal(generacionesDe('groq').length, 2, 'cada usuario paga su propia respuesta');
  });

  test('las respuestas de la comunidad NO se cachean (dependen de datos vivos)', async () => {
    instalarFetch({ chat: () => ({ texto: 'Depende de la config del server.' }) });
    ia._internos.cacheRespuestas.clear();

    await conversar('u-cache-comunidad', 'que reglas tiene el server', contextoGuild('100000000000000023'));
    await conversar('u-cache-comunidad', 'que reglas tiene el server', contextoGuild('100000000000000023'));

    assert.equal(generacionesDe('groq').length, 2, 'pregunta de la comunidad = se vuelve a responder');
  });

  test('agotado el presupuesto del día, el bot responde sin IA (y lo cuenta)', async () => {
    const limiteAntes = process.env.IA_LIMITE_DIARIO;
    process.env.IA_LIMITE_DIARIO = '1';
    presupuesto.reiniciar(GUILD);
    const sinCupoAntes = ia.getStatsIA().sinCupo;

    try {
      instalarFetch({ chat: () => ({ texto: 'respuesta de IA' }) });
      const primera = await conversar('u-cupo-1', 'quien gano el mundial 2022', contextoGuild('100000000000000024'));
      assert.equal(primera.texto, 'respuesta de IA', 'la primera entra en el presupuesto');
      assert.equal(presupuesto.estadoDe(GUILD).usadas, 1);

      // Segunda pregunta del día: sin IA → null, y el bot cae a su repertorio local.
      const segunda = await conversar('u-cupo-2', 'cual es la capital de australia', contextoGuild('100000000000000025'));
      assert.equal(segunda, null);
      assert.ok(ia.getStatsIA().sinCupo > sinCupoAntes);
      assert.equal(presupuesto.estadoDe(GUILD).agotado, true);
      assert.equal(generacionesDe('groq').length, 1, 'no se gastó ninguna llamada con el cupo agotado');
    } finally {
      if (limiteAntes === undefined) delete process.env.IA_LIMITE_DIARIO;
      else process.env.IA_LIMITE_DIARIO = limiteAntes;
      presupuesto.reiniciar(GUILD);
    }
  });

  test('la caché no gasta presupuesto (se contesta sin IA)', async () => {
    const limiteAntes = process.env.IA_LIMITE_DIARIO;
    process.env.IA_LIMITE_DIARIO = '2';
    presupuesto.reiniciar(GUILD);
    ia._internos.cacheRespuestas.clear();

    try {
      instalarFetch({ chat: () => ({ texto: 'Dato general.' }) });
      await conversar('u-cupo-cache', 'quien fue san martin', contextoGuild('100000000000000026'));
      await conversar('u-cupo-cache', 'quien fue san martin', contextoGuild('100000000000000026'));

      assert.equal(presupuesto.estadoDe(GUILD).usadas, 1, 'la segunda no consumió cupo');
      assert.equal(generacionesDe('groq').length, 1);
    } finally {
      if (limiteAntes === undefined) delete process.env.IA_LIMITE_DIARIO;
      else process.env.IA_LIMITE_DIARIO = limiteAntes;
      presupuesto.reiniciar(GUILD);
    }
  });
});

// ---------- Salud del motor: modelos caídos, pausas y carrera ----------
//
// Este bloque cubre el bug real que hacía lento al bot: Groq retiró la familia llama
// del plan gratuito (agosto 2026) y el bot la pedía primero en CADA mensaje, se comía
// un 404 y terminaba siempre en Gemini. Estos tests garantizan que un modelo que
// falla no se vuelva a intentar, que un proveedor sin acceso se aparte y que la
// respuesta llegue apenas contesta el primer proveedor que sirva.
describe('salud del motor de IA (modelos caídos, pausas y carrera)', () => {
  const { modelosCaidos, proveedoresPausados, verificarModelos } = ia._internos;

  const LISTA_GROQ = [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }];

  function resetSalud() {
    modelosCaidos.clear();
    proveedoresPausados.clear();
  }

  // Fetch propio para estos casos: permite decidir la respuesta POR MODELO y agregar
  // demoras, cosas que el mock general (que solo distingue proveedor) no cubre.
  function fetchPropio({ groqChat, geminiChat, demoraGroqMs = 0 }) {
    const pedidos = [];
    const original = global.fetch;
    global.fetch = async (url, opciones = {}) => {
      const u = String(url);
      const cuerpo = opciones.body ? JSON.parse(opciones.body) : null;
      if (u.includes('groq.com') && u.includes('/models')) return json({ data: LISTA_GROQ });
      // OJO con el orden: la URL de generación de Gemini también contiene "/models/",
      // así que hay que reconocer primero generateContent.
      if (u.includes('generateContent')) {
        pedidos.push({ proveedor: 'gemini', modelo: u.match(/models\/([^:]+):/)?.[1] });
        return geminiChat ? geminiChat() : json({ candidates: [{ content: { parts: [{ text: 'de gemini' }] }, finishReason: 'STOP' }] });
      }
      // Listado de Gemini: el mock NUNCA debe tocar la red (un test que sale a
      // internet espera el timeout real y ensucia la suite).
      if (u.includes('generativelanguage')) {
        return json({ models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] });
      }
      if (u.includes('chat/completions')) {
        const modelo = cuerpo.model;
        pedidos.push({ proveedor: 'groq', modelo });
        if (demoraGroqMs) {
          // Timer sin ref: la carrera debe resolverse antes y no queremos que un
          // temporizador pendiente mantenga vivo el proceso de tests.
          const esperar = new Promise((_, rechazar) => {
            const t = setTimeout(() => rechazar(new Error('Groq tardó demasiado')), demoraGroqMs);
            t.unref?.();
          });
          await esperar;
        }
        return groqChat ? groqChat(modelo) : json({ choices: [{ message: { content: 'de groq' }, finish_reason: 'stop' }] });
      }
      return original(url, opciones);
    };
    return pedidos;
  }

  test('un modelo retirado (404) se marca caído y NO se reintenta en el mensaje siguiente', async () => {
    resetSalud();
    const pedidos = fetchPropio({
      groqChat: (modelo) =>
        modelo === 'openai/gpt-oss-120b'
          ? json({ error: { message: 'The model does not exist or you do not have access to it.' } }, 404)
          : json({ choices: [{ message: { content: 'respuesta buena' }, finish_reason: 'stop' }] }),
    });

    // Primer mensaje: se come el 404 del modelo retirado y sigue con el que funciona.
    const primera = await conversar('u-caido-1', 'que reglas tiene el server', { usuario: 'Fede' });
    assert.equal(primera.texto, 'respuesta buena');
    assert.deepEqual(
      pedidos.map((p) => p.modelo),
      ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
      'el primer mensaje prueba el modelo caído y sigue con el bueno'
    );

    // Segundo mensaje: el caído ya está en el registro y no se vuelve a pedir.
    const segunda = await conversar('u-caido-2', 'y las sanciones?', { usuario: 'Fede' });
    assert.equal(segunda.texto, 'respuesta buena');
    assert.deepEqual(
      pedidos.map((p) => p.modelo),
      ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-20b'],
      'el modelo retirado no se reintenta: el segundo mensaje va directo al que funciona'
    );
    assert.ok(ia.saludIA().groq.modelosCaidos.includes('openai/gpt-oss-120b'));
  });

  test('una clave sin permiso (401) aparta el proveedor y el mensaje siguiente ni lo intenta', async () => {
    resetSalud();
    const pedidos = fetchPropio({
      groqChat: () => json({ error: { message: 'Invalid API Key' } }, 401),
    });

    const primera = await conversar('u-401-1', 'puedo publicar mi discord', { usuario: 'Fede' });
    assert.equal(primera.texto, 'de gemini', 'responde el respaldo');
    const llamadasGroqTrasLaPrimera = pedidos.filter((p) => p.proveedor === 'groq').length;
    assert.ok(llamadasGroqTrasLaPrimera > 0, 'el primer mensaje sí intenta Groq');
    assert.equal(ia.saludIA().groq.enPausa, true);
    assert.match(ia.saludIA().groq.motivoPausa, /clave/);

    const segunda = await conversar('u-401-2', 'cuantos niveles hay', { usuario: 'Fede' });
    assert.equal(segunda.texto, 'de gemini');
    assert.equal(
      pedidos.filter((p) => p.proveedor === 'groq').length,
      llamadasGroqTrasLaPrimera,
      'con Groq en pausa no se gasta ni una llamada más: eso era la demora de 2 s'
    );
  });

  test('carrera con respaldo: si el principal se demora, contesta el respaldo sin esperarlo', async () => {
    resetSalud();
    const pedidos = fetchPropio({ demoraGroqMs: 3_000 });

    const inicio = Date.now();
    const respuesta = await conversar('u-hedge', 'que comandos hay para niveles', { usuario: 'Fede' });
    const transcurrido = Date.now() - inicio;

    assert.equal(respuesta.texto, 'de gemini');
    assert.ok(transcurrido < 2_600, `no se espera al proveedor lento (tardó ${transcurrido} ms; Groq tardaba 3000 ms)`);
    assert.ok(
      pedidos.some((p) => p.proveedor === 'groq'),
      'el principal igual arranca primero'
    );
    assert.ok(
      pedidos.some((p) => p.proveedor === 'gemini'),
      'y el respaldo sale en paralelo'
    );
  });

  test('si el principal contesta rápido, el respaldo ni se llama', async () => {
    resetSalud();
    const pedidos = fetchPropio({});
    const respuesta = await conversar('u-sin-hedge', 'que comandos hay para niveles', { usuario: 'Fede' });
    assert.equal(respuesta.texto, 'de groq');
    assert.equal(pedidos.filter((p) => p.proveedor === 'gemini').length, 0);
  });

  test('la verificación del arranque prueba los modelos y descarta el retirado', async () => {
    resetSalud();
    fetchPropio({
      groqChat: (modelo) =>
        modelo === 'openai/gpt-oss-120b'
          ? json({ error: { message: 'model not found' } }, 404)
          : json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    });

    await verificarModelos();
    const estado = await ia.estadoIA();
    assert.equal(estado.groq.modelo, 'openai/gpt-oss-20b', 'queda el modelo que funciona');
    assert.ok(estado.groq.modelosCaidos.includes('openai/gpt-oss-120b'));
    assert.equal(estado.groq.enPausa, false);
  });

  test('la latencia real queda medida y /status la puede mostrar', async () => {
    resetSalud();
    fetchPropio({});
    await conversar('u-latencia-1', 'que reglas tiene el server', { usuario: 'Fede' });
    await conversar('u-latencia-2', 'y los niveles?', { usuario: 'Fede' });

    const estado = await ia.estadoIA();
    assert.ok(estado.groq.muestras >= 2, 'hay muestras de latencia de Groq');
    assert.ok(Number.isFinite(estado.groq.p50) && estado.groq.p50 >= 0);
    assert.ok(estado.groq.p95 >= estado.groq.p50, 'el p95 nunca es menor que el p50');
  });

  test('el catálogo de modelos descarta audio, TTS y guardrails (no son chat)', async () => {
    resetSalud();
    // La lista falsa incluye whisky, guard y prompt-guard: ninguno debe ser candidato.
    global.fetch = async (url) => {
      if (String(url).includes('/models')) {
        return json({
          data: [
            { id: 'whisper-large-v3' },
            { id: 'openai/gpt-oss-safeguard-20b' },
            { id: 'meta-llama/llama-prompt-guard-2-22m' },
            { id: 'canopylabs/orpheus-v1-english' },
            { id: 'openai/gpt-oss-120b' },
          ],
        });
      }
      return json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };

    await ia._internos.verificarModelos();
    const estado = await ia.estadoIA();
    assert.equal(estado.groq.modelo, 'openai/gpt-oss-120b');
  });
});

// La cadena de proveedores es una tabla (utils/ia.js): cada proveedor compatible con la
// API de OpenAI se suma con su clave, sin código nuevo. Estos tests prueban que la tabla
// funciona de verdad: respaldo, orden de modelos y filtros propios de cada uno.
describe('proveedores alternativos (Cerebras, OpenRouter, Mistral)', () => {
  const { modelosCaidos, proveedoresPausados, listados } = ia._internos;

  const PATRONES = [
    ['groq.com', 'groq'],
    ['cerebras.ai', 'cerebras'],
    ['openrouter.ai', 'openrouter'],
    ['mistral.ai', 'mistral'],
  ];

  function limpiar() {
    modelosCaidos.clear();
    proveedoresPausados.clear();
    listados.clear();
  }

  // Pone claves y devuelve cómo restaurar el entorno (los tests no deben filtrarse).
  function conClaves(claves) {
    const previas = Object.entries(claves).map(([variable, valor]) => [variable, process.env[variable], valor]);
    for (const [variable, , valor] of previas) process.env[variable] = valor;
    return () => {
      for (const [variable, anterior] of previas) {
        if (anterior === undefined) delete process.env[variable];
        else process.env[variable] = anterior;
      }
    };
  }

  // Todas las APIs compatibles comparten forma: /models → data, /chat/completions →
  // choices[0].message.content. Un solo mock alcanza para todas.
  function fetchCompatibles({ modelos = {}, chat = {} } = {}) {
    const pedidos = [];
    global.fetch = async (url, opciones = {}) => {
      const u = String(url);
      const cuerpo = opciones.body ? JSON.parse(opciones.body) : null;
      if (u.includes('generativelanguage')) {
        return u.includes('generateContent')
          ? json({ candidates: [{ content: { parts: [{ text: 'de gemini' }] }, finishReason: 'STOP' }] })
          : json({ models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] });
      }
      const proveedor = PATRONES.find(([frag]) => u.includes(frag))?.[1] ?? 'otro';
      if (u.endsWith('/models')) {
        pedidos.push({ proveedor, tipo: 'listado' });
        return json({ data: (modelos[proveedor] ?? [`modelo-de-${proveedor}`]).map((id) => ({ id })) });
      }
      pedidos.push({ proveedor, tipo: 'chat', modelo: cuerpo?.model, autorizacion: opciones.headers?.Authorization });
      const respuesta = chat[proveedor];
      if (typeof respuesta === 'function') return respuesta(cuerpo.model);
      return json({ choices: [{ message: { content: respuesta ?? `de ${proveedor}` }, finish_reason: 'stop' }] });
    };
    return pedidos;
  }

  test('sin clave el proveedor no existe para el bot: no se llama ni aparece en /status', async () => {
    limpiar();
    const pedidos = fetchCompatibles();

    assert.deepEqual(ia.proveedoresConfigurados(), ['groq', 'gemini'], 'solo los que tienen clave');
    const estado = await ia.estadoIA();
    assert.equal(estado.cerebras, undefined, 'un proveedor sin clave no ensucia el diagnóstico');

    await conversar('u-sin-clave', 'que reglas tiene el server', { usuario: 'Fede' });
    assert.equal(pedidos.filter((p) => p.proveedor === 'cerebras').length, 0);
  });

  test('con clave, Cerebras responde cuando Groq está en pausa', async () => {
    limpiar();
    const restaurar = conClaves({ CEREBRAS_API_KEY: 'clave' });
    try {
      proveedoresPausados.set('groq', { hasta: Date.now() + 60_000, motivo: 'cuota agotada' });
      const pedidos = fetchCompatibles();

      const respuesta = await conversar('u-cerebras', 'que reglas tiene el server', { usuario: 'Fede' });

      assert.equal(respuesta.texto, 'de cerebras', 'el respaldo contesta igual que cualquier otro');
      const chat = pedidos.filter((p) => p.tipo === 'chat');
      assert.equal(chat[0].proveedor, 'cerebras', 'la cadena arranca por el que sigue en la tabla');
      assert.match(chat[0].autorizacion, /^Bearer clave$/, 'usa su propia clave');
      assert.equal(ia.getStatsIA().cerebras, 1, 'el uso queda contado por proveedor');
    } finally {
      restaurar();
    }
  });

  test('Cerebras: un modelo retirado se descarta y se pasa al siguiente', async () => {
    limpiar();
    const restaurar = conClaves({ CEREBRAS_API_KEY: 'clave' });
    try {
      // Groq y Gemini en pausa: el mensaje lo tiene que resolver Cerebras solo.
      proveedoresPausados.set('groq', { hasta: Date.now() + 60_000, motivo: 'cuota agotada' });
      proveedoresPausados.set('gemini', { hasta: Date.now() + 60_000, motivo: 'cuota agotada' });
      const pedidos = fetchCompatibles({
        modelos: { cerebras: ['llama-3.3-70b', 'llama3.1-8b'] },
        chat: {
          cerebras: (modelo) =>
            modelo === 'llama-3.3-70b'
              ? json({ error: { message: 'model not found' } }, 404)
              : json({ choices: [{ message: { content: 'de cerebras' }, finish_reason: 'stop' }] }),
        },
      });

      const respuesta = await conversar('u-cerebras-caido', 'que reglas tiene el server', { usuario: 'Fede' });

      assert.equal(respuesta.texto, 'de cerebras');
      assert.deepEqual(
        pedidos.filter((p) => p.tipo === 'chat').map((p) => p.modelo),
        ['llama-3.3-70b', 'llama3.1-8b'],
        'el retirado se prueba una vez y el mensaje igual se responde'
      );
      assert.ok(ia.saludIA().cerebras.modelosCaidos.includes('llama-3.3-70b'), 'cada proveedor lleva su propio registro de modelos caídos');
    } finally {
      restaurar();
    }
  });

  test('OpenRouter: la clave nunca gasta en un modelo de pago (solo los :free)', async () => {
    limpiar();
    const restaurar = conClaves({ OPENROUTER_API_KEY: 'clave' });
    try {
      fetchCompatibles({
        modelos: {
          openrouter: ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct:free', 'anthropic/claude-sonnet-4'],
        },
      });

      await ia._internos.listarModelosDe('openrouter');
      assert.deepEqual(
        ia._internos.candidatosDe('openrouter'),
        ['meta-llama/llama-3.3-70b-instruct:free'],
        'los de pago quedan fuera aunque estén en el catálogo'
      );
      assert.ok(ia.PROVEEDORES.openrouter.cabeceras['HTTP-Referer'], 'se identifica con la comunidad, como pide OpenRouter');
    } finally {
      restaurar();
    }
  });

  test('Mistral: sumar un proveedor es una clave más, sin tocar el motor', async () => {
    limpiar();
    const restaurar = conClaves({ MISTRAL_API_KEY: 'clave' });
    try {
      proveedoresPausados.set('groq', { hasta: Date.now() + 60_000, motivo: 'cuota agotada' });
      proveedoresPausados.set('gemini', { hasta: Date.now() + 60_000, motivo: 'cuota agotada' });
      const pedidos = fetchCompatibles({ chat: { mistral: 'de mistral' } });

      const respuesta = await conversar('u-mistral', 'que reglas tiene el server', { usuario: 'Fede' });

      assert.equal(respuesta.texto, 'de mistral');
      assert.equal(pedidos.filter((p) => p.tipo === 'chat')[0].proveedor, 'mistral');
      const estado = await ia.estadoIA();
      assert.equal(estado.mistral.configurada, true);
      assert.ok(estado.mistral.modelo, '/status lo muestra con su modelo elegido');
    } finally {
      restaurar();
    }
  });
});
