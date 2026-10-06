// Tests de /serverinfo: el conteo de humanos y bots.
//
// El bug que cubre: si la descarga de la lista de miembros fallaba (gateway lento, sin
// permiso), se contaban los bots de una caché PARCIAL y se restaban del total real, así
// que el comando informaba más humanos de los que hay sin decir nada. Ahora, cuando no
// puede medir, lo dice.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-serverinfo-'));

const serverinfo = require('../src/commands/serverinfo');

function coleccion(items = []) {
  const mapa = new Map(items.map((i) => [i.id, i]));
  return {
    get size() {
      return mapa.size;
    },
    filter: (fn) => coleccion([...mapa.values()].filter(fn)),
    map: (fn) => [...mapa.values()].map(fn),
  };
}

const miembro = (id, bot) => ({ id, user: { id, bot } });

function guildFake({ memberCount = 3, cache = [], completos = cache, fetchFalla = false } = {}) {
  const guild = {
    id: 'g-serverinfo',
    name: 'TriGGer.Arena',
    ownerId: 'dueno',
    memberCount,
    description: null,
    createdAt: new Date('2020-01-01'),
    iconURL: () => null,
    bannerURL: () => null,
    verificationLevel: 2,
    mfaLevel: 0,
    partnered: false,
    verified: false,
    vanityURLCode: null,
    premiumSubscriptionCount: 3,
    premiumTier: 1,
    channels: {
      cache: coleccion([
        { id: 'c1', type: 0 },
        { id: 'c2', type: 0 },
        { id: 'c3', type: 2 },
      ]),
    },
    roles: { cache: coleccion([{ id: 'r1' }]) },
    emojis: { cache: coleccion([]) },
    stickers: { cache: coleccion([]) },
    members: {
      cache: coleccion(cache),
      // Discord.js hace exactamente esto: descargar la lista deja la caché completa.
      fetch: async () => {
        if (fetchFalla) throw new Error('gateway timeout');
        guild.members.cache = coleccion(completos);
        return guild.members.cache;
      },
    },
  };
  return guild;
}

function interaccionFake(guild) {
  const llamadas = { defers: [], edits: [] };
  const ix = {
    guild,
    guildId: guild.id,
    async deferReply(payload) {
      llamadas.defers.push(payload);
    },
    async editReply(payload) {
      llamadas.edits.push(payload);
      return payload;
    },
  };
  return { ix, llamadas };
}

const texto = (embed) => {
  const data = embed.data ?? embed;
  return [data.title, data.description, ...(data.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n');
};

describe('/serverinfo — conteo de miembros', () => {
  test('con la caché completa no descarga nada y muestra humanos y bots', async () => {
    const guild = guildFake({
      memberCount: 3,
      cache: [miembro('h1', false), miembro('h2', false), miembro('b1', true)],
    });
    const { ix, llamadas } = interaccionFake(guild);
    await serverinfo.execute(ix);

    assert.equal(llamadas.defers[0].flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
    const t = texto(llamadas.edits[0].embeds[0]);
    assert.match(t, /Miembros: \*\*3\*\*\n2 humanos · 1 bots/);
  });

  test('si no puede descargar la lista, no inventa un número de humanos', async () => {
    // El total real es 500, pero solo hay 2 miembros en caché (1 bot).
    const guild = guildFake({
      memberCount: 500,
      cache: [miembro('h1', false), miembro('b1', true)],
      fetchFalla: true,
    });
    const { ix, llamadas } = interaccionFake(guild);
    await serverinfo.execute(ix);

    const t = texto(llamadas.edits[0].embeds[0]);
    assert.match(t, /\*\*500\*\*/, 'el total sí se muestra: lo da la API del servidor');
    assert.match(t, /no pude descargar la lista completa/);
    assert.doesNotMatch(t, /humanos/, 'no puede afirmar cuántos humanos hay sin la lista');
  });

  test('cuando la descarga funciona, los números quedan exactos', async () => {
    const guild = guildFake({
      memberCount: 5,
      cache: [miembro('b1', true)], // caché parcial: falta gente
      completos: [miembro('h1', false), miembro('h2', false), miembro('h3', false), miembro('b1', true), miembro('b2', true)],
    });
    const { ix, llamadas } = interaccionFake(guild);
    await serverinfo.execute(ix);

    const t = texto(llamadas.edits[0].embeds[0]);
    assert.match(t, /3 humanos · 2 bots/);
    assert.doesNotMatch(t, /no pude descargar/);
  });
});
