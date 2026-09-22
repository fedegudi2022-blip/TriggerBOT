// Tests de src/db/puente.js — comandos de la web con validaciones y config real.
// Sin base de datos configurada: procesarFila()/estadoBot() no tocan la red.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-puente-'));

const puente = require('../src/db/puente');
const store = require('../src/store');

// ---------- Fakes de Discord ----------
const CANAL_ID = '111222333444555666'; // snowflake realista (numérico)

function canalFake(id) {
  const canal = { id, name: `canal-${id}`, enviados: [] };
  canal.send = async (payload) => {
    canal.enviados.push(payload);
    return { id: 'msg-1' };
  };
  return canal;
}

function guildFake(id) {
  const canal = canalFake(CANAL_ID);
  const guild = {
    id,
    name: `Server ${id}`,
    memberCount: 42,
    channels: { cache: new Map([[canal.id, canal]]) },
  };
  guild.channels.cache.set(canal.id, canal);
  return guild;
}

function clientFake({ ready = true } = {}) {
  const guild = guildFake('g-web-1');
  return {
    isReady: () => ready,
    ws: { ping: 55 },
    commands: new Map([['ping', {}], ['ban', {}]]),
    guilds: { cache: new Map([[guild.id, guild]]) },
  };
}

describe('procesarFila — validaciones y whitelist', () => {
  test('rechaza comandos desconocidos', async () => {
    const res = await puente.procesarFila({ comando: 'formatear_disco', argumentos: {}, guild_id: 'g-web-1' }, clientFake());
    assert.equal(res.ok, false);
    assert.match(res.error, /desconocido/);
  });

  test('recargar_config funciona sin argumentos y responde OK', async () => {
    const res = await puente.procesarFila({ comando: 'recargar_config', argumentos: {}, guild_id: null }, clientFake());
    assert.equal(res.ok, true);
  });

  test('rechaza publicar_anuncio con canal inválido o mensaje vacío', async () => {
    const client = clientFake();
    const r1 = await puente.procesarFila({ comando: 'publicar_anuncio', argumentos: { canal_id: 'no-es-id', mensaje: 'hola' }, guild_id: 'g-web-1' }, client);
    assert.equal(r1.ok, false);

    const r2 = await puente.procesarFila({ comando: 'publicar_anuncio', argumentos: { canal_id: CANAL_ID, mensaje: '   ' }, guild_id: 'g-web-1' }, client);
    assert.equal(r2.ok, false);
    assert.match(r2.error, /mensaje vacío/);
  });

  test('publicar_anuncio envía el embed al canal y reporta el resultado', async () => {
    const client = clientFake();
    const res = await puente.procesarFila(
      { comando: 'publicar_anuncio', argumentos: { canal_id: CANAL_ID, titulo: 'Prueba', mensaje: 'Hola desde la web' }, guild_id: 'g-web-1' },
      client
    );
    assert.equal(res.ok, true);
    assert.match(res.detalle, /anuncio enviado/);
    const canal = client.guilds.cache.get('g-web-1').channels.cache.get(CANAL_ID);
    assert.equal(canal.enviados.length, 1);
    assert.match(canal.enviados[0].embeds[0].data.description, /Hola desde la web/);
  });

  test('rechaza guild donde el bot no está', async () => {
    const res = await puente.procesarFila({ comando: 'set_ia', argumentos: { activada: true }, guild_id: 'g-no-estoy' }, clientFake());
    assert.equal(res.ok, false);
    assert.match(res.error, /no está en el servidor/);
  });

  test('set_canales aplica solo claves válidas con snowflake válido', async () => {
    const res = await puente.procesarFila(
      {
        comando: 'set_canales',
        argumentos: { modlog: '111111111111111111', bienvenida: '222222222222222222', hacks: 'malo' },
        guild_id: 'g-web-1',
      },
      clientFake()
    );
    assert.equal(res.ok, true);
    const config = store.getGuildConfig('g-web-1');
    assert.equal(config.modlog, '111111111111111111');
    assert.equal(config.welcome.channelId, '222222222222222222');
    assert.equal(config.hacks, undefined, 'las claves fuera de la whitelist no se aplican');
  });

  test('set_canales rechaza snowflakes inválidos', async () => {
    const res = await puente.procesarFila(
      { comando: 'set_canales', argumentos: { modlog: 'cascade; drop table' }, guild_id: 'g-web-1' },
      clientFake()
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /ningún canal válido/);
  });

  test('set_proteccion valida rangos y acciones', async () => {
    const client = clientFake();
    const ok = await puente.procesarFila(
      {
        comando: 'set_proteccion',
        argumentos: { activado: true, accionSpam: 'timeout', spamMensajes: 7, raidJoins: 99999, accionRaid: 'nuke' },
        guild_id: 'g-web-1',
      },
      client
    );
    assert.equal(ok.ok, true);
    const prot = store.getGuildConfig('g-web-1').proteccion;
    assert.equal(prot.activado, true);
    assert.equal(prot.accionSpam, 'timeout');
    assert.equal(prot.spamMensajes, 7);
    assert.equal(prot.raidJoins, undefined, 'valores fuera de rango se ignoran');
    assert.equal(prot.accionRaid, undefined, 'acciones desconocidas se ignoran');
  });

  test('set_ia activa y desactiva', async () => {
    const client = clientFake();
    await puente.procesarFila({ comando: 'set_ia', argumentos: { activada: true }, guild_id: 'g-web-1' }, client);
    assert.equal(store.getGuildConfig('g-web-1').iaActivada, true);
    await puente.procesarFila({ comando: 'set_ia', argumentos: { activada: false }, guild_id: 'g-web-1' }, client);
    assert.equal(store.getGuildConfig('g-web-1').iaActivada, false);
  });

  test('set_ia sin booleano explícito falla', async () => {
    const res = await puente.procesarFila({ comando: 'set_ia', argumentos: { activada: 'sí' }, guild_id: 'g-web-1' }, clientFake());
    assert.equal(res.ok, false);
  });

  test('si el bot no terminó de conectar, ningún comando se ejecuta', async () => {
    const res = await puente.procesarFila({ comando: 'set_ia', argumentos: { activada: true }, guild_id: 'g-web-1' }, clientFake({ ready: false }));
    assert.equal(res.ok, false);
    assert.match(res.error, /conectando/);
  });
});

describe('estadoBot — forma del estado publicado', () => {
  test('incluye ping, servidores con datos y memoria', () => {
    const estado = puente.estadoBot(clientFake());
    assert.equal(estado.online, true);
    assert.equal(estado.pingMs, 55);
    assert.equal(estado.servidores, 1);
    assert.equal(estado.comandos, 2);
    assert.ok(Array.isArray(estado.guilds));
    assert.equal(estado.guilds[0].nombre, 'Server g-web-1');
    assert.ok(estado.uptimeSeg >= 0);
    assert.ok(estado.memoriaMb > 0);
    assert.ok(estado.ultimaRevision);
  });

  test('tolera un client a medio conectar (sin ws.ping válido)', () => {
    const estado = puente.estadoBot({ isReady: () => false, commands: new Map(), guilds: { cache: new Map() } });
    assert.equal(estado.online, false);
    assert.equal(estado.pingMs, null);
    assert.equal(estado.servidores, 0);
  });
});
