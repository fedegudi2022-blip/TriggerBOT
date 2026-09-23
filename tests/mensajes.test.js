// Tests de la consistencia visual y de la política de respuestas.
//
// Cubren las tres decisiones que hacen que el bot "se sienta uno solo":
//   1. una sola paleta (nadie inventa hex sueltos);
//   2. los comandos que hablan con la API difieren ANTES de ir a la red;
//   3. la escalada de advertencias es configurable, no un 3-warns cableado.
//
// Este archivo arranca con una guarda que recorre el código real: si alguien vuelve
// a escribir un color a mano, el test falla y dice en qué archivo.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-msg-'));

const { COLORS, brandEmbed, successEmbed, errorEmbed, warnEmbed, infoEmbed } = require('../src/utils/replies');
const escalada = require('../src/utils/escalada');
const store = require('../src/store');

const RAIZ = path.join(__dirname, '..');

// ---------- Guarda de la paleta ----------

// Recorre src/ y devuelve los archivos que tienen un literal 0xRRGGBB fuera de
// replies.js (donde vive la paleta) y de a2s.js (menciona magia de protocolo en
// comentarios, no colores).
function archivosConHexPropio() {
  const culpables = [];
  const visita = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        visita(completo);
        continue;
      }
      if (!entrada.name.endsWith('.js')) continue;
      const relativo = path.relative(RAIZ, completo).split(path.sep).join('/');
      if (relativo === 'src/utils/replies.js' || relativo === 'src/utils/a2s.js') continue;
      const texto = fs.readFileSync(completo, 'utf8');
      for (const linea of texto.split('\n')) {
        // Solo nos importan los colores: `0xFFFFFFFF` de un protocolo no tiene 6
        // dígitos exactos entre otros, así que el patrón con límites lo descarta.
        if (/\b0x[0-9a-fA-F]{6}\b/.test(linea)) culpables.push(`${relativo}: ${linea.trim()}`);
      }
    }
  };
  visita(path.join(RAIZ, 'src'));
  return culpables;
}

describe('paleta única (replies.js)', () => {
  test('ningún archivo del bot tiene colores hardcodeados', () => {
    const culpables = archivosConHexPropio();
    assert.deepEqual(
      culpables,
      [],
      `Estos colores salieron de la paleta (usá COLORS de utils/replies.js):\n${culpables.join('\n')}`
    );
  });

  test('los colores semánticos son los que esperan los helpers y los acentos están declarados', () => {
    assert.equal(COLORS.success, 0x57f287);
    assert.equal(COLORS.error, 0xed4245);
    assert.equal(COLORS.info, 0x5865f2);
    assert.equal(COLORS.warn, 0xfee75c);
    for (const acento of ['servidor', 'carino', 'logro', 'neutral', 'reddit', 'gris', 'naranja']) {
      assert.ok(COLORS[acento], `falta el acento ${acento}`);
    }
    // Cada helper usa su color: si alguien cambia uno, el otro tiene que seguirlo.
    assert.equal(successEmbed('ok').data.color, COLORS.success);
    assert.equal(errorEmbed('no').data.color, COLORS.error);
    assert.equal(warnEmbed('ojo').data.color, COLORS.warn);
    assert.equal(infoEmbed('dato').data.color, COLORS.info);
    assert.equal(brandEmbed({}).data.color, COLORS.info, 'el color por defecto es el neutro de marca');
  });
});

// ---------- Diferido antes de la red ----------

// Colección mínima con la API que usan los comandos (filter/map/sort/size):
// discord.js expone Collection, que hereda de Map con estos métodos.
function coleccion(items = []) {
  const mapa = new Map(items.map((x) => [x.id ?? String(Math.random()), x]));
  return {
    size: mapa.size,
    get: (k) => mapa.get(k),
    has: (k) => mapa.has(k),
    values: () => mapa.values(),
    [Symbol.iterator]: () => mapa[Symbol.iterator](),
    filter: (fn) => coleccion([...mapa.values()].filter(fn)),
    map: (fn) => [...mapa.values()].map(fn),
    sort: (fn) => coleccion([...mapa.values()].sort(fn)),
    find: (fn) => [...mapa.values()].find(fn),
  };
}

// Interacción mínima que registra el ORDEN de las llamadas: es lo que permite
// verificar que el defer va antes del trabajo lento.
function interaccionConOrden(opciones = {}, { fallarDefer = false } = {}) {
  const orden = [];
  const member = {
    id: 'usuario-1',
    displayName: 'Fede',
    displayColor: 0,
    accentColor: null,
    avatar: null,
    nick: null,
    nickname: null,
    premiumSince: null,
    joinedTimestamp: Date.now() - 86_400_000,
    permissions: { has: () => false },
    roles: { cache: coleccion(), highest: null },
    displayAvatarURL: () => 'https://ejemplo.com/avatar.png',
  };

  const interaction = {
    guildId: 'g-msg-1',
    channelId: 'canal-1',
    member,
    guild: {
      id: 'g-msg-1',
      name: 'TriGGer.Arena',
      ownerId: 'dueno',
      channels: { cache: coleccion() },
      roles: { cache: coleccion() },
      members: { cache: coleccion(), me: { id: 'bot' }, fetch: async () => null },
    },
    user: { id: 'usuario-1', tag: 'fede#0001', username: 'fede', createdTimestamp: Date.now() - 1e9, displayAvatarURL: () => 'https://ejemplo.com/a.png' },
    client: { user: { id: 'bot', username: 'Trigger' }, users: { fetch: async () => ({ id: 'usuario-1', tag: 'fede#0001', bannerURL: () => null }) } },
    channel: { id: 'canal-1', name: 'general', send: async () => ({ id: 'msg-1' }) },
    deferred: false,
    replied: false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isFromMessage: () => false,
    options: {
      getUser: () => opciones.usuario ?? null,
      getMember: () => null,
      getString: (n) => opciones[n] ?? null,
      getInteger: (n) => opciones[n] ?? null,
      getBoolean: (n) => opciones[n] ?? null,
      getChannel: (n) => opciones[n] ?? null,
      getSubcommand: () => opciones.sub ?? null,
    },
    async deferReply() {
      if (fallarDefer) throw new Error('ya fue diferida');
      orden.push('defer');
      interaction.deferred = true;
    },
    async reply() {
      orden.push('reply');
      interaction.replied = true;
      return {};
    },
    editReplyPayloads: [],
    async editReply(payload) {
      orden.push('editReply');
      interaction.editReplyPayloads.push(payload);
      return {};
    },
    async fetchReply() {
      return { id: 'msg-1', react: async () => {} };
    },
    async deleteReply() {},
  };

  return { interaction, orden };
}

// El orden se mide con el fetch de la API como testigo: se envuelve para anotar
// cuándo entró realmente la llamada de red.
const testigos = () => {
  const eventos = [];
  return {
    eventos,
    marcar: (nombre) => eventos.push(nombre),
  };
};

describe('los comandos que consultan la API difieren antes de la red', () => {
  test('/avatar difiere antes de pedir el perfil', async () => {
    const comandos = require('../src/commands/avatar');
    const t = testigos();
    const { interaction, orden } = interaccionConOrden();
    const fetchOriginal = interaction.client.users.fetch;
    interaction.client.users.fetch = async (...args) => {
      t.marcar('fetch');
      return fetchOriginal(...args);
    };

    await comandos.execute(interaction);
    assert.deepEqual(orden, ['defer', 'editReply']);
    assert.ok(orden.includes('defer'), 'siempre difiere');
    assert.equal(t.eventos[0], 'fetch', 'el fetch ocurre después del defer');
  });

  test('/userinfo difiere antes de pedir el perfil (y responde en privado)', async () => {
    const comandos = require('../src/commands/userinfo');
    const { interaction, orden } = interaccionConOrden();
    await comandos.execute(interaction);
    assert.equal(orden[0], 'defer');
    assert.equal(orden.at(-1), 'editReply');
  });

  test('/serverinfo difiere antes de descargar la lista de miembros', async () => {
    const comandos = require('../src/commands/serverinfo');
    const { interaction, orden } = interaccionConOrden();
    let descargaDespuesDelDefer = false;
    const guild = {
      id: 'g-msg-2',
      name: 'TriGGer.Arena',
      description: null,
      ownerId: 'dueno',
      memberCount: 500,
      createdTimestamp: Date.now() - 1e10,
      premiumSubscriptionCount: 3,
      premiumTier: 1,
      verificationLevel: 2,
      mfaLevel: 0,
      partnered: false,
      verified: false,
      vanityURLCode: null,
      iconURL: () => 'https://ejemplo.com/icon.png',
      bannerURL: () => null,
      members: {
        cache: coleccion(),
        fetch: async () => {
          descargaDespuesDelDefer = orden.includes('defer');
          return coleccion();
        },
      },
      channels: { cache: coleccion() },
      roles: { cache: coleccion([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }, { id: 'r4' }]) },
      emojis: { cache: coleccion([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]) },
      stickers: { cache: coleccion([{ id: 's1' }]) },
    };
    interaction.guild = guild;

    await comandos.execute(interaction);
    assert.equal(orden[0], 'defer', 'el defer va primero');
    assert.equal(descargaDespuesDelDefer, true, 'la descarga de miembros ocurre diferida');
  });

  test('/ip y /servidores difieren antes de consultar los servidores A2S', async () => {
    // Se reemplaza la consulta A2S: sin esto el test abre un socket de verdad y
    // espera el timeout real del protocolo.
    const monitoreo = require('../src/utils/monitoreo');
    const consultarOriginal = monitoreo.consultar;
    monitoreo.consultar = async () => ({ ok: false });

    for (const nombre of ['ip', 'servidores']) {
      const comandos = require(`../src/commands/${nombre}`);
      const { interaction, orden } = interaccionConOrden();
      interaction.guild = { id: `g-msg-${nombre}`, name: 'TriGGer.Arena', channels: { cache: coleccion() } };
      store.escribir(interaction.guild.id, {
        servidores: { lista: [{ nombre: 'Público', host: '127.0.0.1', puerto: 27015 }] },
      });

      await comandos.execute(interaction);
      const iDefer = orden.indexOf('defer');
      assert.ok(iDefer >= 0, `${nombre} tiene que diferir`);
      assert.ok(iDefer < orden.length - 1, `${nombre} responde después del defer`);
    }

    monitoreo.consultar = consultarOriginal;
  });

  test('/frases publicar avisa si Discord rechaza el envío (no confirma un éxito falso)', async () => {
    const frases = require('../src/commands/frases');
    const { interaction, orden } = interaccionConOrden({ sub: 'publicar' });
    interaction.channel.send = async () => {
      throw new Error('Missing Permissions');
    };
    store.escribir(interaction.guildId, {
      fraseDelDia: { canalId: 'canal-1', hora: 12, frases: [{ texto: 'hola', autor: 'Fede' }] },
    });

    await frases.execute(interaction);
    assert.equal(orden[0], 'defer');
    const editado = interaction.editReplyPayloads.at(-1);
    assert.match(JSON.stringify(editado), /No pude publicar la frase/);
    assert.doesNotMatch(JSON.stringify(editado), /Frase publicada/);
  });

  test('/ticket publicar avisa si el panel no se pudo publicar', async () => {
    const ticket = require('../src/commands/ticket');
    const { interaction, orden } = interaccionConOrden({ sub: 'publicar' });
    interaction.channel.send = async () => {
      throw new Error('Missing Permissions');
    };

    await ticket.execute(interaction);
    assert.equal(orden[0], 'defer');
    assert.match(JSON.stringify(interaction.editReplyPayloads.at(-1)), /No pude publicar el panel/);
  });
});

// ---------- Escalada configurable ----------

function miembroEscalable({ moderatable = true, kickable = true, bannable = true, manageable = true } = {}) {
  const m = {
    id: 'infractor',
    moderatable,
    kickable,
    bannable,
    manageable,
    guild: { id: 'g-esc', name: 'TriGGer.Arena', roles: { cache: new Map() }, channels: { cache: new Map() } },
    user: { id: 'infractor', tag: 'infractor#0001', displayAvatarURL: () => 'https://ejemplo.com/a.png', send: async () => {} },
    timeouts: [],
    kicks: [],
    baneos: [],
    rolesAgregados: [],
    roles: { cache: new Map(), highest: { position: 1 } },
    permissions: { has: () => false },
  };
  m.timeout = async (ms, motivo) => {
    if (!moderatable) throw new Error('Missing Permissions');
    m.timeouts.push({ ms, motivo });
  };
  m.kick = async (motivo) => {
    if (!kickable) throw new Error('Missing Permissions');
    m.kicks.push(motivo);
  };
  m.ban = async (opciones) => {
    if (!bannable) throw new Error('Missing Permissions');
    m.baneos.push(opciones);
  };
  m.roles.add = async (rol) => m.rolesAgregados.push(rol);
  return m;
}

describe('escalada de advertencias (utils/escalada.js)', () => {
  test('sin configuración mantiene el comportamiento histórico: 3 avisos → 1 hora', () => {
    const e = escalada.resolver({});
    assert.equal(e.activada, true);
    assert.equal(e.umbral, 3);
    assert.equal(e.duracion, 60);
    assert.equal(e.accion, 'timeout');
    assert.equal(escalada.duracionMs(e), 3_600_000);
  });

  test('valores rotos o fuera de rango se acotan en vez de romper /warn', () => {
    assert.equal(escalada.resolver({ escalada: { umbral: 0 } }).umbral, 1);
    assert.equal(escalada.resolver({ escalada: { umbral: 999 } }).umbral, 20);
    assert.equal(escalada.resolver({ escalada: { umbral: 'tres' } }).umbral, 3);
    assert.equal(escalada.resolver({ escalada: { duracion: 0 } }).duracion, 1);
    assert.equal(escalada.resolver({ escalada: { duracion: 999999 } }).duracion, 40_320);
    assert.equal(escalada.resolver({ escalada: { accion: 'explotar' } }).accion, 'timeout');
    assert.equal(escalada.resolver({ escalada: { activada: false } }).activada, false);
  });

  test('corresponde respeta umbral, apagado y la acción "no sancionar"', () => {
    const base = escalada.resolver({ escalada: { umbral: 2 } });
    assert.equal(escalada.corresponde(base, 1), false);
    assert.equal(escalada.corresponde(base, 2), true);
    assert.equal(escalada.corresponde(base, 30), true);
    assert.equal(escalada.corresponde(escalada.resolver({ escalada: { activada: false } }), 10), false);
    assert.equal(escalada.corresponde(escalada.resolver({ escalada: { accion: 'ninguna' } }), 10), false);
  });

  test('describir explica la política en una línea, incluida la del silencio con rol', () => {
    assert.match(escalada.describir(escalada.resolver({})), /3\*\* advertencia.*1 hora/);
    assert.match(escalada.describir(escalada.resolver({ escalada: { accion: 'mute' } })), /no vence solo/);
    assert.match(escalada.describir(escalada.resolver({ escalada: { activada: false } })), /apagada/i);
    assert.match(escalada.describir(escalada.resolver({ escalada: { accion: 'ninguna' } })), /no se sanciona/);
  });

  test('aplicar ejecuta la acción configurada y reporta el resultado real', async () => {
    const e = escalada.resolver({ escalada: { umbral: 2, duracion: 30 } });

    const timeoutOk = await escalada.aplicar(miembroEscalable(), e, 'motivo');
    assert.equal(timeoutOk.ok, true);
    assert.equal(timeoutOk.tipo, 'timeout');

    const kick = miembroEscalable();
    const rKick = await escalada.aplicar(kick, escalada.resolver({ escalada: { accion: 'kick' } }), 'motivo');
    assert.equal(rKick.ok, true);
    assert.deepEqual(kick.kicks, ['motivo']);

    const ban = miembroEscalable();
    const rBan = await escalada.aplicar(ban, escalada.resolver({ escalada: { accion: 'ban' } }), 'motivo');
    assert.equal(rBan.ok, true);
    assert.equal(ban.baneos[0].reason, 'motivo');
  });

  test('aplicar no miente si Discord rechaza o si la jerarquía lo impide', async () => {
    const rechazado = await escalada.aplicar(
      miembroEscalable({ moderatable: false }),
      escalada.resolver({ escalada: { accion: 'timeout' } }),
      'motivo'
    );
    assert.equal(rechazado.ok, false);
    assert.equal(rechazado.tipo, 'timeout');
    assert.match(rechazado.error, /por encima del mío/);

    const sinPermiso = await escalada.aplicar(
      miembroEscalable({ kickable: false }),
      escalada.resolver({ escalada: { accion: 'kick' } }),
      'motivo'
    );
    assert.equal(sinPermiso.ok, false);
    assert.match(sinPermiso.error, /No puedo expulsarlo/);
  });
});

describe('warn usa la escalada configurada', () => {
  const warn = require('../src/commands/warn');

  test('avisarPorDM nunca escapa: si el usuario no acepta DMs, la advertencia sigue', async () => {
    const { avisarPorDM } = require('../src/utils/moderation');
    await avisarPorDM({ send: () => Promise.reject(new Error('Cannot send messages to this user')) }, 'texto');
    await avisarPorDM(
      {
        send: () => {
          throw new Error('síncrono');
        },
      },
      'texto'
    );
  });

  function interaccionWarn(guildId) {
    const orden = [];
    const miembro = miembroEscalable();
    const moderator = {
      id: 'mod-1',
      displayName: 'Mod',
      permissions: { has: () => true },
      roles: { cache: new Map(), highest: { position: 10 } },
    };
    const interaction = {
      guildId,
      guild: { id: guildId, name: 'TriGGer.Arena', ownerId: 'dueno', members: { me: { id: 'bot' }, cache: new Map() }, channels: { cache: new Map() }, roles: { cache: new Map() } },
      channelId: 'canal-1',
      channel: { id: 'canal-1', send: async () => ({ id: 'm' }) },
      user: { id: moderator.id, tag: 'Mod#0001', username: 'Mod' },
      member: moderator,
      client: { user: { id: 'bot', tag: 'bot#0001' } },
      deferred: false,
      options: {
        getUser: () => miembro.user,
        getMember: () => miembro,
        getString: () => 'flodeo',
        getBoolean: () => false,
      },
      async deferReply() {
        orden.push('defer');
        interaction.deferred = true;
      },
      async reply() {
        orden.push('reply');
        return {};
      },
      async editReply(payload) {
        orden.push('editReply');
        interaction.respuesta = payload;
        return payload;
      },
    };
    return { interaction, miembro, orden };
  }

  test('con umbral 5, el 3.º aviso NO sanciona (antes sí)', async () => {
    const guildId = 'g-warn-5';
    store.escribir(guildId, { escalada: { umbral: 5, accion: 'timeout', duracion: 60 } });
    for (let i = 0; i < 3; i++) {
      const { interaction, miembro } = interaccionWarn(guildId);
      await warn.execute(interaction);
      assert.equal(miembro.timeouts.length, 0, 'todavía no corresponde la escalada');
    }
    const { interaction, miembro } = interaccionWarn(guildId);
    await warn.execute(interaction);
    assert.equal(miembro.timeouts.length, 0, 'el 4.º tampoco');
    const quinto = interaccionWarn(guildId);
    await warn.execute(quinto.interaction);
    assert.equal(quinto.miembro.timeouts.length, 1, 'el 5.º sí');
    assert.equal(quinto.miembro.timeouts[0].ms, 3_600_000);
  });

  test('con la acción en expulsar, el aviso que llega al umbral expulsa', async () => {
    const guildId = 'g-warn-kick';
    store.escribir(guildId, { escalada: { umbral: 2, accion: 'kick', duracion: 30 } });
    await warn.execute(interaccionWarn(guildId).interaction);
    const segundo = interaccionWarn(guildId);
    await warn.execute(segundo.interaction);
    assert.equal(segundo.miembro.kicks.length, 1);
    assert.match(JSON.stringify(segundo.interaction.respuesta), /Expulsar/);
  });

  test('si la escalada falla, la advertencia se guarda igual y el mensaje lo dice', async () => {
    const guildId = 'g-warn-falla';
    store.escribir(guildId, { escalada: { umbral: 1, accion: 'timeout', duracion: 15 } });
    const { interaction, miembro } = interaccionWarn(guildId);
    miembro.moderatable = false;

    await warn.execute(interaction);
    const texto = JSON.stringify(interaction.respuesta);
    assert.match(texto, /no se aplicó/i);
    assert.match(texto, /por encima del mío/);
    assert.equal(store.getGuildConfig(guildId).escalada.umbral, 1);
  });

  test('con la escalada apagada, el aviso solo acumula historial', async () => {
    const guildId = 'g-warn-off';
    store.escribir(guildId, { escalada: { activada: false } });
    const { interaction, miembro } = interaccionWarn(guildId);
    for (let i = 0; i < 4; i++) await warn.execute(interaccionWarn(guildId).interaction);
    await warn.execute(interaction);
    assert.equal(miembro.timeouts.length, 0);
    assert.match(JSON.stringify(interaction.respuesta), /Historial/);
  });
});
