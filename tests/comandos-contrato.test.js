// Batería de contrato de TODOS los comandos.
//
// No se ejecutan contra Discord: se ejecutan contra fakes y se exige el comportamiento
// mínimo que el resto del bot asume de cualquier comando:
//   · nunca lanza una excepción hacia afuera (index.js la convertiría en un error
//     genérico y el usuario no se enteraría de nada útil),
//   · siempre contesta algo o difiere (un comando mudo deja "La aplicación no respondió"),
//   · no se cuelga,
//   · si es de staff y quien lo usa no lo es, contesta en efímero con el motivo.
//
// Los pocos comandos que dependen de infraestructura real (red, DNS, A2S) están en
// EXCLUIDOS con el motivo a la vista, para que el agujero sea explícito y no silencioso.
// Cada proceso de test usa su propio directorio de datos.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-contrato-'));

const { cargarComandos } = require('../src/commandLoader');
const { SOLO_STAFF } = require('../src/utils/guia');
const { MessageFlags } = require('discord.js');

const comandos = cargarComandos();

// Sin fakes posibles: dependen de la red o del proceso real.
const EXCLUIDOS = new Map([
  ['diag', 'mide la salida a internet del host (DNS real)'],
  ['buscar', 'consulta la web'],
  ['meme', 'trae un post de Reddit'],
]);

const GUILD = 'guild-contrato';
const YO = 'usuario-yo';
const OBJETIVO = 'usuario-objetivo';
const LARGO_MAXIMO_MS = 3000;

// ---------- Fakes ----------
// Colección mínima con la forma que usan los comandos (.get/.values/.size/.filter/.find/.map).
function coleccion(items = []) {
  const mapa = new Map(items.map((i) => [i.id, i]));
  return {
    get: (id) => mapa.get(id),
    values: () => mapa.values(),
    keys: () => mapa.keys(),
    get size() {
      return mapa.size;
    },
    has: (id) => mapa.has(id),
    find: (fn) => [...mapa.values()].find(fn),
    filter: (fn) => coleccion([...mapa.values()].filter(fn)),
    sort: (fn) => coleccion([...mapa.values()].sort(fn)),
    map: (fn) => [...mapa.values()].map(fn),
    some: (fn) => [...mapa.values()].some(fn),
    every: (fn) => [...mapa.values()].every(fn),
    forEach: (fn) => [...mapa.values()].forEach(fn),
    first: () => mapa.values().next().value,
    toArray: () => [...mapa.values()],
    [Symbol.iterator]: () => mapa.values(),
  };
}

function usuarioFake(id, bot = false) {
  return {
    id,
    bot,
    username: `u${id}`,
    displayName: `u${id}`,
    tag: `u${id}#0`,
    displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png',
    avatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png',
    bannerURL: () => null,
    hexAccentColor: null,
    discriminator: '0',
    flags: { toArray: () => [] },
    createdAt: new Date(),
    toString: () => `<@${id}>`,
    createdTimestamp: Date.now() - 86_400_000 * 400,
    fetch: async () => usuarioFake(id, bot),
  };
}

const ROL = { id: 'rol-1', name: 'Staff', position: 5, managed: false, color: 0, toString: () => '<@&rol-1>' };
const ROL_TODOS = { id: GUILD, name: '@everyone', position: 0, managed: false, color: 0, toString: () => '@everyone' };

function miembroFake(id, { staff = false, bot = false, alto = false } = {}) {
  return {
    id,
    user: usuarioFake(id, bot),
    displayName: `u${id}`,
    nickname: null,
    joinedTimestamp: Date.now() - 86_400_000 * 30,
    permissions: { has: () => staff || alto },
    roles: { cache: coleccion(staff ? [ROL] : []), add: async () => {}, remove: async () => {}, highest: ROL },
    timeout: async () => {},
    kick: async () => {},
    ban: async () => {},
    voice: { channelId: null, selfMute: false, selfDeaf: false, disconnect: async () => {}, setChannel: async () => {} },
    send: async () => {},
  };
}

function canalFake(id = 'canal-general') {
  const canal = {
    id,
    name: 'general',
    type: 0,
    topic: null,
    nsfw: false,
    isTextBased: () => true,
    isThread: () => false,
    send: async () => {},
    sendTyping: async () => {},
    setName: async () => {},
    setTopic: async () => {},
    setUserLimit: async () => {},
    setBitrate: async () => {},
    setRateLimitPerUser: async () => {},
    setParent: async () => {},
    delete: async () => {},
    permissionOverwrites: { edit: async () => {}, cache: coleccion([]) },
    messages: { fetch: async () => coleccion([]), delete: async () => {} },
    members: coleccion([]),
    permissionsFor: () => ({ has: () => true }),
    toString: () => `<#${id}>`,
  };
  return canal;
}

function clientFake() {
  const client = {
    commands: new Map(comandos.map((c) => [c.data.name, c])),
    user: {
      id: 'bot',
      username: 'TriggerBOT',
      tag: 'TriggerBOT#0',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png',
      toString: () => '<@bot>',
    },
    ws: { ping: 42 },
    users: { fetch: async (id) => usuarioFake(id), cache: coleccion([]) },
    channels: { fetch: async (id) => canalFake(id), cache: coleccion([]) },
    guilds: { cache: coleccion([]) },
  };
  return client;
}

// ---------- Interacción fake ----------
// Los comandos con subcomandos reciben el primero de su propio builder: así se ejercita
// una rama real y no un `getSubcommand()` que devuelve cualquier cosa.
function subcomandoDe(comando) {
  const json = comando.data.toJSON();
  return (json.options ?? []).find((o) => o.type === 1)?.name ?? null;
}

// Definición de cada opción por nombre, para saber cuáles son obligatorias: Discord
// garantiza las obligatorias, así que el escenario "sin opciones" solo deja nulas las
// opcionales, que es el caso que de verdad puede llegar desde el cliente.
function opcionesDe(comando) {
  const json = comando.data.toJSON();
  const mapa = new Map();
  for (const opcion of json.options ?? []) {
    if (opcion.type === 1) {
      for (const sub of opcion.options ?? []) mapa.set(sub.name, sub);
    } else {
      mapa.set(opcion.name, opcion);
    }
  }
  return mapa;
}

function construirInteraccion(comando, { staff, conOpciones, registro }) {
  const client = clientFake();
  const memberMe = miembroFake('bot');
  memberMe.permissions = { has: () => true };
  const guild = {
    id: GUILD,
    name: 'Servidor de prueba',
    ownerId: 'dueno',
    memberCount: 2,
    iconURL: () => null,
    bannerURL: () => null,
    afkChannelId: null,
    createdAt: new Date(),
    channels: { cache: coleccion([canalFake()]), create: async () => canalFake(), fetch: async () => canalFake() },
    members: {
      cache: coleccion([miembroFake(YO, { staff }), miembroFake(OBJETIVO), miembroFake('dueno', { alto: true })]),
      me: memberMe,
      fetch: async (id) => miembroFake(id),
      ban: async () => {},
      kick: async () => {},
    },
    roles: { cache: coleccion([ROL, ROL_TODOS]), everyone: ROL_TODOS, create: async () => ROL },
    emojis: { cache: coleccion([]) },
    bans: { fetch: async () => coleccion([]), remove: async () => {}, create: async () => {} },
    voiceStates: { cache: coleccion([]) },
    stickers: { cache: coleccion([]) },
    commands: { set: async () => {} },
  };
  client.guilds.cache = coleccion([guild]);

  const canal = guild.channels.cache.get('canal-general');
  canal.guild = guild;
  const miembro = guild.members.cache.get(YO);
  const definiciones = opcionesDe(comando);

  const valor = (nombre, tipo, exigidoPorCodigo = false) => {
    const requerido = exigidoPorCodigo || definiciones.get(nombre)?.required === true;
    if (!conOpciones && !requerido) return null;
    if (tipo === 'user') return usuarioFake(OBJETIVO);
    if (tipo === 'member') return guild.members.cache.get(OBJETIVO);
    if (tipo === 'integer' || tipo === 'number') return 1;
    if (tipo === 'boolean') return false;
    if (tipo === 'channel') return canal;
    if (tipo === 'role') return ROL;
    if (tipo === 'mentionable') return guild.members.cache.get(OBJETIVO);
    if (tipo === 'attachment') return { url: 'https://cdn.discordapp.com/a.png', name: 'a.png', size: 1024 };
    return 'texto de prueba';
  };

  const interaccion = {
    client,
    guild,
    guildId: GUILD,
    channel: canal,
    channelId: canal.id,
    commandName: comando.data.name,
    // Los de menú contextual traen el objetivo del click derecho en targetUser.
    targetUser: usuarioFake(OBJETIVO),
    targetMember: guild.members.cache.get(OBJETIVO),
    targetId: OBJETIVO,
    commandType: comando.data.toJSON().type ?? 1,
    isUserContextMenuCommand: () => (comando.data.toJSON().type ?? 1) === 2,
    user: usuarioFake(YO),
    member: miembro,
    createdTimestamp: Date.now(),
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isAutocomplete: () => false,
    options: {
      getSubcommand: () => subcomandoDe(comando) ?? '',
      getSubcommandGroup: () => null,
      getFocused: () => '',
      getUser: (n, e) => valor(n, 'user', e),
      getMember: (n, e) => valor(n, 'member', e),
      getString: (n, e) => valor(n, 'string', e),
      getInteger: (n, e) => valor(n, 'integer', e),
      getNumber: (n, e) => valor(n, 'number', e),
      getBoolean: (n, e) => valor(n, 'boolean', e),
      getChannel: (n, e) => valor(n, 'channel', e),
      getRole: (n, e) => valor(n, 'role', e),
      getMentionable: (n, e) => valor(n, 'mentionable', e),
      getAttachment: (n, e) => valor(n, 'attachment', e),
    },
    reply: async (payload) => {
      registro.respuestas.push(payload);
      interaccion.replied = true;
      return payload;
    },
    deferReply: async (opciones = {}) => {
      registro.deferido = true;
      registro.efimeros += opciones?.flags === MessageFlags.Ephemeral ? 1 : 0;
      interaccion.deferred = true;
      return {};
    },
    editReply: async (payload) => {
      registro.respuestas.push(payload);
      return payload;
    },
    followUp: async (payload) => {
      registro.respuestas.push(payload);
      return payload;
    },
    update: async (payload) => {
      registro.respuestas.push(payload);
      return payload;
    },
    deleteReply: async () => {},
    fetchReply: async () => ({ id: 'mensaje-1', edit: async () => {}, react: async () => {}, delete: async () => {} }),
    showModal: async () => {
      registro.modal = true;
    },
  };
  return interaccion;
}

// Corre el comando con tope de tiempo: un comando colgado es un fallo del contrato.
async function correr(comando, opciones) {
  const registro = { respuestas: [], deferido: false, efimeros: 0, modal: false, error: null };
  const interaccion = construirInteraccion(comando, { ...opciones, registro });
  let timer = null;

  try {
    await Promise.race([
      Promise.resolve(comando.execute(interaccion, interaccion.client)),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`no contestó en ${LARGO_MAXIMO_MS} ms`)), LARGO_MAXIMO_MS);
      }),
    ]);
  } catch (error) {
    registro.error = error;
  } finally {
    clearTimeout(timer);
  }
  return registro;
}

const efimero = (payload) => Boolean(payload?.flags && payload.flags & MessageFlags.Ephemeral);

describe('contrato de los comandos', () => {
  const jugables = comandos.filter((c) => !EXCLUIDOS.has(c.data.name));

  test('la batería cubre todos los comandos salvo los excluidos a propósito', () => {
    assert.ok(jugables.length >= 45, `se esperaban al menos 45 comandos ejecutables, hay ${jugables.length}`);
    assert.deepEqual(
      comandos.filter((c) => EXCLUIDOS.has(c.data.name)).map((c) => c.data.name).sort(),
      [...EXCLUIDOS.keys()].sort(),
      'la lista de excluidos tiene que hablar de comandos que existen'
    );
  });

  test('sin permiso: ningún comando tira ni se queda mudo', async () => {
    let deStaffVerificados = 0;

    for (const comando of jugables) {
      const r = await correr(comando, { staff: false, conOpciones: true });
      const nombre = comando.data.name;
      assert.equal(r.error, null, `/${nombre} tiró: ${r.error?.message}`);
      assert.ok(r.deferido || r.modal || r.respuestas.length > 0, `/${nombre} no contestó nada`);

      // Los de staff tienen que avisar en efímero, no contestarle al canal.
      if (SOLO_STAFF.has(nombre) && r.respuestas.length) {
        deStaffVerificados += 1;
        assert.ok(
          r.respuestas.some(efimero),
          `/${nombre} es de staff y contestó en público: ${JSON.stringify(r.respuestas[0]).slice(0, 120)}`
        );
      }
    }

    // Cota de cobertura: sin esto la batería podría pasar sin haber ejercitado ningún
    // comando de staff (por ejemplo, si el fake deja de cargar los comandos).
    assert.ok(deStaffVerificados >= 15, `solo se verificaron ${deStaffVerificados} comandos de staff sin permiso`);
  });

  test('con permiso: ningún comando tira ni se queda mudo', async () => {
    for (const comando of jugables) {
      const r = await correr(comando, { staff: true, conOpciones: true });
      const nombre = comando.data.name;
      assert.equal(r.error, null, `/${nombre} tiró con permisos: ${r.error?.message}`);
      assert.ok(r.deferido || r.modal || r.respuestas.length > 0, `/${nombre} no contestó nada`);
    }
  });

  test('sin opciones cargadas: los comandos avisan en vez de explotar', async () => {
    for (const comando of jugables) {
      const r = await correr(comando, { staff: true, conOpciones: false });
      const nombre = comando.data.name;
      assert.equal(r.error, null, `/${nombre} tiró sin opciones: ${r.error?.message}`);
      assert.ok(r.deferido || r.modal || r.respuestas.length > 0, `/${nombre} no contestó nada sin opciones`);
    }
  });
});
