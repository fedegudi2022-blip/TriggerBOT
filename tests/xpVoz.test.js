// Tests de la XP por voz (src/utils/xpVoz.js): cuándo paga, qué la bloquea y cómo
// reacciona al subir de nivel. El tiempo se controla pasando `ahora` a la pasada, así no
// dependen de timers reales.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-xpvoz-'));

const xpVoz = require('../src/utils/xpVoz');
const niveles = require('../src/niveles');
const { setGuildConfig } = require('../src/store');

const GUILD = 'guild-voz';
const CANAL_VOZ = 'voz-1';

// Colección mínima con la forma que usa el código (.get / .values / .size / .filter).
function coleccion(items) {
  const mapa = new Map(items.map((i) => [i.id, i]));
  return {
    get: (id) => mapa.get(id),
    values: () => mapa.values(),
    get size() {
      return mapa.size;
    },
    filter: (fn) => coleccion([...mapa.values()].filter(fn)),
  };
}

function usuarioFake(id, bot = false) {
  return { id, bot, username: `u${id}`, toString: () => `<@${id}>` };
}

function miembroFake(id, { bot = false, selfMute = false, selfDeaf = false, canalId = CANAL_VOZ } = {}) {
  return { id, user: usuarioFake(id, bot), voice: { channelId: canalId, selfMute, selfDeaf } };
}

// Un servidor de mentira con lo justo. `enCanal` es mutable: los tests le agregan o le
// sacan gente para probar que no se acumula tiempo mientras no corresponde.
function escenario({ personas = [], conAnuncios = false } = {}) {
  const enviados = [];
  const enCanal = [...personas];
  const anuncios = { id: 'canal-log', send: async (payload) => enviados.push(payload) };
  const canalVoz = {
    id: CANAL_VOZ,
    get members() {
      return coleccion(enCanal);
    },
    send: async () => {},
  };

  const guild = {
    id: GUILD,
    afkChannelId: null,
    channels: { cache: coleccion(conAnuncios ? [canalVoz, anuncios] : [canalVoz]) },
    members: { cache: coleccion(personas) },
    voiceStates: { cache: coleccion(personas.map((m) => ({ id: m.id, channelId: m.voice.channelId }))) },
  };
  for (const m of personas) m.guild = guild;

  const client = { guilds: { cache: coleccion([guild]) } };
  return { client, guild, canalVoz, enCanal, enviados, anuncios };
}

function presencia(id, { ultimoPago = 0 } = {}) {
  const p = xpVoz.presencias.get(`${GUILD}:${id}`);
  p.ultimoPago = ultimoPago;
  return p;
}

function datos(id) {
  return niveles.datosDe(GUILD, id);
}

describe('XP por voz: presencia', () => {
  test('anota al entrar y la borra al salir', () => {
    xpVoz.resetear();
    const { guild } = escenario();

    assert.equal(xpVoz.registrar({ guild, id: 'a', channelId: CANAL_VOZ }), true);
    assert.equal(xpVoz.presencias.size, 1);

    xpVoz.registrar({ guild, id: 'a', channelId: null });
    assert.equal(xpVoz.presencias.size, 0, 'al salir no queda nada que pagar');
  });

  test('cambiar de canal reinicia el conteo', () => {
    xpVoz.resetear();
    const { guild } = escenario();

    xpVoz.registrar({ guild, id: 'a', channelId: CANAL_VOZ }, 1000);
    xpVoz.registrar({ guild, id: 'a', channelId: 'voz-2' }, 2000);

    const p = xpVoz.presencias.get(`${GUILD}:a`);
    assert.equal(p.canalId, 'voz-2');
    assert.ok(p.ultimoPago > 1000, 'no arrastra el minuto del canal anterior');
  });

  test('sembrar registra a quien ya estaba conectado cuando arranca el bot', () => {
    xpVoz.resetear();
    const { client } = escenario({ personas: [miembroFake('a'), miembroFake('b')] });

    xpVoz.sembrar(client);
    assert.equal(xpVoz.presencias.size, 2);
  });
});

describe('XP por voz: enganche con el evento', () => {
  test('el evento de voz anota la presencia y el canal también maneja los temporales', async () => {
    xpVoz.resetear();
    const { guild } = escenario();
    const evento = require('../src/events/voiceStateUpdate');

    // Con estados mínimos los canales temporales pueden fallar: van en su propio
    // try/catch, y lo que se verifica acá es que la XP por voz quede anotada igual.
    await evento.execute({}, { guild, id: 'a', channelId: CANAL_VOZ });
    assert.equal(xpVoz.presencias.size, 1, 'sin el enganche, la XP por voz nunca pagaría');

    await evento.execute({}, { guild, id: 'a', channelId: null });
    assert.equal(xpVoz.presencias.size, 0);
  });
});

describe('XP por voz: reglas de anti-abuso', () => {
  test('paga solo cuando corresponde', () => {
    const guild = { id: GUILD, afkChannelId: 'afk' };
    const dos = [miembroFake('a'), miembroFake('b')];
    const canal = { id: CANAL_VOZ, members: coleccion(dos) };

    assert.equal(xpVoz.motivoParaNoPagar(dos[0], canal, guild), null, 'dos personas despiertas: paga');
    assert.equal(xpVoz.motivoParaNoPagar(miembroFake('c', { bot: true }), canal, guild), 'es un bot');
    assert.equal(xpVoz.motivoParaNoPagar(miembroFake('d', { selfMute: true }), canal, guild), 'está muteado o sordo');
    assert.equal(xpVoz.motivoParaNoPagar(miembroFake('e', { selfDeaf: true }), canal, guild), 'está muteado o sordo');

    const solo = { id: CANAL_VOZ, members: coleccion([dos[0]]) };
    assert.equal(xpVoz.motivoParaNoPagar(dos[0], solo, guild), 'está solo en el canal');

    // Un bot no cuenta como compañía.
    const conBot = { id: CANAL_VOZ, members: coleccion([dos[0], miembroFake('bot2', { bot: true })]) };
    assert.equal(xpVoz.motivoParaNoPagar(dos[0], conBot, guild), 'está solo en el canal');

    const enAfk = miembroFake('f', { canalId: 'afk' });
    const canalAfk = { id: 'afk', members: coleccion([enAfk, miembroFake('g', { canalId: 'afk' })]) };
    assert.equal(xpVoz.motivoParaNoPagar(enAfk, canalAfk, guild), 'es el canal AFK');

    xpVoz.ganadoHoy.set('a', xpVoz.MAXIMO_DIARIO);
    assert.equal(xpVoz.motivoParaNoPagar(dos[0], canal, guild), 'llegó al tope diario');
    xpVoz.ganadoHoy.clear();
  });

  test('los canales excluidos y el interruptor del staff no pagan', () => {
    setGuildConfig(GUILD, (c) => {
      c.voz = { canalesSinXP: ['voz-sin-xp'] };
    });
    const guild = { id: GUILD, afkChannelId: null };
    const enCanal = [miembroFake('a', { canalId: 'voz-sin-xp' }), miembroFake('b', { canalId: 'voz-sin-xp' })];
    const canal = { id: 'voz-sin-xp', members: coleccion(enCanal) };

    assert.equal(xpVoz.motivoParaNoPagar(enCanal[0], canal, guild), 'canal excluido');

    // Salida rápida del staff: apagar la XP por voz en todo el servidor.
    setGuildConfig(GUILD, (c) => {
      c.voz = { xpActivada: false };
    });
    assert.equal(xpVoz.motivoParaNoPagar(enCanal[0], canal, guild), 'XP por voz desactivada');

    setGuildConfig(GUILD, (c) => {
      delete c.voz;
    });
  });
});

describe('XP por voz: pago por minuto', () => {
  test('paga recién al minuto completo, no antes', async () => {
    xpVoz.resetear();
    niveles.escribir(GUILD, { a: { xp: 100, nivel: 1, mensajes: 5, logros: [] } });
    const { client, guild } = escenario({ personas: [miembroFake('a'), miembroFake('b')] });
    xpVoz.registrar({ guild, id: 'a', channelId: CANAL_VOZ });
    presencia('a', { ultimoPago: 1_000_000 });

    await xpVoz.pasada(client, 1_000_000 + 30_000);
    assert.equal(datos('a').xp, 100, 'medio minuto no paga');

    await xpVoz.pasada(client, 1_000_000 + xpVoz.PERIODO_MS);
    assert.equal(datos('a').xp, 100 + xpVoz.POR_MINUTO);
  });

  test('estando solo no paga y tampoco acumula el tiempo', async () => {
    xpVoz.resetear();
    niveles.escribir(GUILD, { a: { xp: 100, nivel: 1, mensajes: 5, logros: [] } });
    const solo = miembroFake('a');
    const { client, guild, enCanal } = escenario({ personas: [solo] });
    xpVoz.registrar({ guild, id: 'a', channelId: CANAL_VOZ });
    presencia('a', { ultimoPago: 0 });

    const t = 5 * 60_000;
    await xpVoz.pasada(client, t); // cinco minutos solo
    assert.equal(datos('a').xp, 100, 'solo no paga');

    // Llega alguien: el reloj arranca de cero, no paga los cinco minutos del aire.
    enCanal.push(miembroFake('b'));
    await xpVoz.pasada(client, t + 30_000);
    assert.equal(datos('a').xp, 100, 'no acumuló los minutos en los que estaba solo');

    await xpVoz.pasada(client, t + xpVoz.PERIODO_MS);
    assert.equal(datos('a').xp, 100 + xpVoz.POR_MINUTO);
  });

  test('mutearse a mitad de camino corta el pago', async () => {
    xpVoz.resetear();
    niveles.escribir(GUILD, { a: { xp: 100, nivel: 1, mensajes: 5, logros: [] } });
    const persona = miembroFake('a');
    const { client, guild } = escenario({ personas: [persona, miembroFake('b')] });
    xpVoz.registrar({ guild, id: 'a', channelId: CANAL_VOZ }, 0);

    // Se mutea: el evento reinicia el minuto y el barrido no paga.
    xpVoz.registrar({ guild, id: 'a', channelId: CANAL_VOZ, selfMute: true }, 10_000);
    persona.voice.selfMute = true;
    await xpVoz.pasada(client, xpVoz.PERIODO_MS);
    assert.equal(datos('a').xp, 100, 'muteado no paga');

    // Se desmutea a mitad del minuto siguiente: ese minuto tampoco se cobra entero.
    persona.voice.selfMute = false;
    xpVoz.registrar({ guild, id: 'a', channelId: CANAL_VOZ, selfMute: false }, xpVoz.PERIODO_MS + 30_000);
    await xpVoz.pasada(client, xpVoz.PERIODO_MS * 2);
    assert.equal(datos('a').xp, 100, 'al desmutearse el minuto arranca de cero');

    await xpVoz.pasada(client, xpVoz.PERIODO_MS * 2 + xpVoz.PERIODO_MS);
    assert.equal(datos('a').xp, 100 + xpVoz.POR_MINUTO, 'con el minuto completo vuelve a pagar');
  });

  test('el tope diario corta el pago', async () => {
    xpVoz.resetear();
    niveles.escribir(GUILD, { a: { xp: 100, nivel: 1, mensajes: 5, logros: [] } });
    const { client, guild } = escenario({ personas: [miembroFake('a'), miembroFake('b')] });
    xpVoz.registrar({ guild, id: 'a', channelId: CANAL_VOZ }, 0);
    xpVoz.reiniciarDia(); // el primer barrido limpia el contador del día
    xpVoz.ganadoHoy.set('a', xpVoz.MAXIMO_DIARIO - 3);

    await xpVoz.pasada(client, xpVoz.PERIODO_MS);
    assert.equal(datos('a').xp, 103, 'paga lo que le queda del tope, no el minuto completo');

    presencia('a', { ultimoPago: xpVoz.PERIODO_MS });
    await xpVoz.pasada(client, xpVoz.PERIODO_MS * 2);
    assert.equal(datos('a').xp, 103, 'con el tope agotado no paga más');
  });

  test('si la XP de voz hace subir de nivel, anuncia en el canal configurado', async () => {
    xpVoz.resetear();
    setGuildConfig(GUILD, (c) => {
      c.canalNiveles = 'canal-log';
    });
    // A 4 XP del nivel 1: el minuto de 8 XP lo cruza.
    niveles.escribir(GUILD, { a: { xp: niveles.xpParaNivel(1) - 4, nivel: 0, mensajes: 3, logros: [] } });
    const { client, guild, enviados } = escenario({ personas: [miembroFake('a'), miembroFake('b')], conAnuncios: true });
    xpVoz.registrar({ guild, id: 'a', channelId: CANAL_VOZ });
    presencia('a', { ultimoPago: 0 });

    await xpVoz.pasada(client, xpVoz.PERIODO_MS);

    assert.equal(datos('a').nivel, 1);
    assert.equal(enviados.length, 1, 'un solo mensaje, como por mensajes');
    assert.equal(enviados[0].embeds, undefined, 'es texto, no embed');
    assert.ok(enviados[0].content.includes('subió al nivel **1**'), enviados[0].content);
    assert.ok(enviados[0].content.includes('+8 XP'), enviados[0].content);
  });
});
