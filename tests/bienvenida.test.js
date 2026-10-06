// Tests de /bienvenida test.
//
// Lo que importa acá: que la previsualización sea el MISMO embed que publica
// events/guildMemberAdd.js (mismo render, mismo título) y que el comando avise de los
// problemas que hoy solo quedan en la consola (canal borrado, sin permiso, autorol
// inexistente) en vez de mostrar un mensaje que nunca se va a ver.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-bienvenida-'));

const store = require('../src/store');
const bienvenidaCmd = require('../src/commands/bienvenida');
const { renderWelcome, embedBienvenida } = require('../src/events/guildMemberAdd');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

const GUILD = 'g-bienvenida';
const CANAL = 'canal-bienvenida';
const ROL = 'rol-nuevo';

function guildFake({ canal = true, autorol = ROL, puedeEscribir = true } = {}) {
  const canalFake = {
    id: CANAL,
    enviados: [],
    permissionsFor: () => ({ has: () => puedeEscribir }),
    async send(payload) {
      if (!puedeEscribir) throw new Error('Missing Permissions');
      canalFake.enviados.push(payload);
      return { id: 'msg-1' };
    },
  };
  return {
    id: GUILD,
    name: 'TriggerGaming',
    memberCount: 1234,
    channels: { cache: new Map(canal ? [[CANAL, canalFake]] : []) },
    roles: { cache: new Map(autorol ? [[autorol, { id: autorol }]] : []) },
    members: { me: { id: 'bot' } },
    canal: canalFake,
  };
}

function interaccionFake(guild, { staff = true, enviar = null } = {}) {
  const llamadas = { replies: [] };
  const miembro = {
    id: 'staff-1',
    displayName: 'Fede',
    // Igual que un User real: el alias (displayName) vive en el miembro, no en el user.
    user: { id: 'staff-1', username: 'fede', displayAvatarURL: () => 'https://cdn.discordapp.com/a.png' },
    permissions: { has: () => staff },
    roles: { cache: { has: () => false } },
  };
  const ix = {
    guild,
    guildId: guild.id,
    user: { id: 'staff-1', username: 'fede', toString: () => '<@staff-1>' },
    member: miembro,
    options: { getBoolean: (n) => (n === 'enviar' ? enviar : null), getSubcommand: () => 'test' },
    async reply(payload) {
      llamadas.replies.push(payload);
      return payload;
    },
  };
  return { ix, llamadas };
}

const efimero = (payload) => Boolean(payload?.flags && payload.flags & MessageFlags.Ephemeral);
const texto = (embed) => {
  const data = embed.data ?? embed;
  return [data.title, data.description, ...(data.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n');
};

describe('render de bienvenida (compartido con el evento de ingreso)', () => {
  test('reemplaza {usuario}, {servidor} y {miembros}', () => {
    const guild = guildFake();
    const member = { id: 'nuevo-1', guild, user: { id: 'nuevo-1', username: 'nuevo' } };
    assert.equal(renderWelcome('Hola {usuario} en **{servidor}** ({miembros})', member), 'Hola <@nuevo-1> en **TriggerGaming** (1234)');
  });

  test('sin mensaje configurado usa el de por defecto', () => {
    const guild = guildFake();
    const member = { id: 'nuevo-2', guild, user: { id: 'nuevo-2', username: 'nuevo' } };
    assert.match(renderWelcome(undefined, member), /¡Bienvenido <@nuevo-2> a \*\*TriggerGaming\*\*! Sos el miembro #1234/);
  });

  test('el embed lleva el nombre del que entra y su avatar', () => {
    const guild = guildFake();
    const member = { id: 'nuevo-3', guild, user: { id: 'nuevo-3', username: 'nuevo', displayAvatarURL: () => 'https://cdn.discordapp.com/n.png' } };
    const embed = embedBienvenida({ welcome: { message: '¡Hola {usuario}!' } }, member);
    assert.equal(embed.data.title, '¡nuevo se unió!');
    assert.equal(embed.data.description, '¡Hola <@nuevo-3>!');
    assert.equal(embed.data.thumbnail.url, 'https://cdn.discordapp.com/n.png');
  });
});

describe('/bienvenida test', () => {
  test('sin canal configurado manda a /config en vez de inventar una previsualización', async () => {
    store.escribir(GUILD, {});
    const { ix, llamadas } = interaccionFake(guildFake());
    await bienvenidaCmd.execute(ix);

    assert.ok(efimero(llamadas.replies[0]));
    assert.match(texto(llamadas.replies[0].embeds[0]), /no tiene un canal de bienvenida/);
    assert.match(texto(llamadas.replies[0].embeds[0]), /\/config/);
  });

  test('muestra el mensaje y el estado real de la configuración', async () => {
    store.escribir(GUILD, { welcome: { channelId: CANAL, message: '¡Bienvenido {usuario} a {servidor}!' }, autorole: ROL });
    const guild = guildFake();
    const { ix, llamadas } = interaccionFake(guild);
    await bienvenidaCmd.execute(ix);

    const [preview, estado] = llamadas.replies[0].embeds;
    assert.equal(preview.data.title, '¡fede se unió!');
    assert.equal(preview.data.description, '¡Bienvenido <@staff-1> a TriggerGaming!');
    assert.match(texto(estado), /Canal: <#canal-bienvenida>/);
    assert.match(texto(estado), /Mensaje: personalizado/);
    assert.match(texto(estado), new RegExp(`Autorol: <@&${ROL}>`));
    assert.doesNotMatch(texto(estado), /A revisar/, 'con todo bien configurado no hay nada que revisar');
    assert.ok(efimero(llamadas.replies[0]));
    assert.equal(guild.canal.enviados.length, 0, 'sin enviar:true no se publica nada');
  });

  test('avisa cuando el canal configurado ya no existe', async () => {
    store.escribir(GUILD, { welcome: { channelId: CANAL } });
    const { ix, llamadas } = interaccionFake(guildFake({ canal: false }));
    await bienvenidaCmd.execute(ix);

    assert.match(texto(llamadas.replies[0].embeds[1]), /El canal configurado ya no existe/);
  });

  test('avisa cuando el bot no puede escribir o el autorol no existe', async () => {
    store.escribir(GUILD, { welcome: { channelId: CANAL }, autorole: ROL });
    const sinPermiso = interaccionFake(guildFake({ puedeEscribir: false }));
    await bienvenidaCmd.execute(sinPermiso.ix);
    assert.match(texto(sinPermiso.llamadas.replies[0].embeds[1]), /Me falta el permiso de \*\*Enviar mensajes\*\*/);

    const sinRol = interaccionFake(guildFake({ autorol: null }));
    await bienvenidaCmd.execute(sinRol.ix);
    assert.match(texto(sinRol.llamadas.replies[0].embeds[1]), /rol de autorol configurado ya no existe/);
  });

  test('con enviar:true publica el mismo embed, aclarando que es una prueba y sin mencionar a nadie', async () => {
    store.escribir(GUILD, { welcome: { channelId: CANAL, message: '¡Bienvenido {usuario}!' } });
    const guild = guildFake();
    const { ix, llamadas } = interaccionFake(guild, { enviar: true });
    await bienvenidaCmd.execute(ix);

    assert.equal(guild.canal.enviados.length, 1);
    const enviado = guild.canal.enviados[0];
    assert.match(enviado.content, /Prueba de bienvenida/);
    assert.deepEqual(enviado.allowedMentions, { parse: [] });
    assert.equal(enviado.embeds[0].data.description, '¡Bienvenido <@staff-1>!');
    assert.match(texto(llamadas.replies[0].embeds[0]), /Envié la bienvenida de prueba/);
  });

  test('con enviar:true y sin permiso no ensucia el canal y lo dice', async () => {
    store.escribir(GUILD, { welcome: { channelId: CANAL } });
    const guild = guildFake({ puedeEscribir: false });
    const { ix, llamadas } = interaccionFake(guild, { enviar: true });
    await bienvenidaCmd.execute(ix);

    assert.equal(guild.canal.enviados.length, 0);
    assert.ok(efimero(llamadas.replies[0]));
    assert.match(texto(llamadas.replies[0].embeds[0]), /No puedo escribir en <#canal-bienvenida>/);
  });

  test('un miembro común no puede usarlo', async () => {
    store.escribir(GUILD, { welcome: { channelId: CANAL } });
    const { ix, llamadas } = interaccionFake(guildFake(), { staff: false });
    await bienvenidaCmd.execute(ix);

    assert.equal(llamadas.replies[0].embeds[0].data.title, 'Solo staff');
    assert.ok(efimero(llamadas.replies[0]));
  });
});
