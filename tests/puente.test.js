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

describe('set_config — esquema genérico de configuración', () => {
  // Cada test arranca con la config del server vacía (los tests comparten el store).
  function configFresca() {
    store.escribir('g-web-1', {});
  }

  test('aplica canales, roles y texto de bienvenida juntos', async () => {
    configFresca();
    const res = await puente.procesarFila(
      {
        comando: 'set_config',
        argumentos: {
          modlog: '333333333333333333',
          helperRole: '444444444444444444',
          welcomeMessage: '¡Hola {usuario}!',
          ticketsCategoria: '555555555555555555',
        },
        guild_id: 'g-web-1',
      },
      clientFake()
    );
    assert.equal(res.ok, true);
    assert.match(res.detalle, /4 campos?|config actualizada/);
    const c = store.getGuildConfig('g-web-1');
    assert.equal(c.modlog, '333333333333333333');
    assert.equal(c.helperRole, '444444444444444444');
    assert.equal(c.welcome.message, '¡Hola {usuario}!');
    assert.equal(c.tickets.categoriaId, '555555555555555555');
  });

  test('valida rangos de protección y completa los valores por defecto', async () => {
    configFresca();
    const res = await puente.procesarFila(
      {
        comando: 'set_config',
        argumentos: { spamMensajes: 7, spamSegundos: 9, raidSegundos: 99999, iaActivada: false },
        guild_id: 'g-web-1',
      },
      clientFake()
    );
    assert.equal(res.ok, true);
    const c = store.getGuildConfig('g-web-1');
    assert.equal(c.proteccion.spamMensajes, 7);
    assert.equal(c.proteccion.spamSegundos, 9);
    assert.equal(c.proteccion.raidSegundos, 60, 'fuera de rango se ignora y queda el default');
    assert.equal(c.iaActivada, false);
  });

  test('rechaza snowflakes inválidos y acepta booleans en varios formatos', async () => {
    configFresca();
    const res = await puente.procesarFila(
      { comando: 'set_config', argumentos: { modlog: 'no-soy-id', proteccionActivada: 'true', horaFrases: 20 }, guild_id: 'g-web-1' },
      clientFake()
    );
    assert.equal(res.ok, true);
    const c = store.getGuildConfig('g-web-1');
    assert.equal(c.modlog, undefined);
    assert.equal(c.proteccion.activado, true);
    assert.equal(c.fraseDelDia.hora, 20);
  });

  test('los campos desconocidos se ignoran sin romper los válidos', async () => {
    configFresca();
    const res = await puente.procesarFila(
      { comando: 'set_config', argumentos: { campoMalo: 'x', logs: '666666666666666666' }, guild_id: 'g-web-1' },
      clientFake()
    );
    assert.equal(res.ok, true);
    const c = store.getGuildConfig('g-web-1');
    assert.equal(c.campoMalo, undefined);
    assert.equal(c.logs, '666666666666666666');
  });

  test('frases: agregar y quitar por número', async () => {
    configFresca();
    const client = clientFake();
    const r1 = await puente.procesarFila({ comando: 'agregar_frase', argumentos: { texto: 'Mañana es mejor', autor: 'La web' }, guild_id: 'g-web-1' }, client);
    assert.equal(r1.ok, true);
    const r2 = await puente.procesarFila({ comando: 'agregar_frase', argumentos: { texto: '   ' }, guild_id: 'g-web-1' }, client);
    assert.equal(r2.ok, false);

    const frases = store.getGuildConfig('g-web-1').fraseDelDia.frases;
    assert.equal(frases[0].texto, 'Mañana es mejor');
    assert.equal(frases[0].autor, 'La web');

    const r3 = await puente.procesarFila({ comando: 'quitar_frase', argumentos: { numero: 1 }, guild_id: 'g-web-1' }, client);
    assert.equal(r3.ok, true);
    assert.equal(store.getGuildConfig('g-web-1').fraseDelDia.frases.length, 0);

    const r4 = await puente.procesarFila({ comando: 'quitar_frase', argumentos: { numero: 5 }, guild_id: 'g-web-1' }, client);
    assert.equal(r4.ok, false);
  });

  test('servers CS: agregar, quitar y validación de host', async () => {
    configFresca();
    const client = clientFake();
    const r1 = await puente.procesarFila(
      { comando: 'agregar_server_cs', argumentos: { nombre: 'PÚBLICO', host: 'cs.ejemplo.com', puerto: 27016, modo: 'KZ' }, guild_id: 'g-web-1' },
      client
    );
    assert.equal(r1.ok, true);
    const lista = store.getGuildConfig('g-web-1').servidores.lista;
    assert.equal(lista[0].host, 'cs.ejemplo.com');
    assert.equal(lista[0].puerto, 27016);

    const r2 = await puente.procesarFila(
      { comando: 'agregar_server_cs', argumentos: { nombre: 'Malo', host: 'espacio en blanco' }, guild_id: 'g-web-1' },
      client
    );
    assert.equal(r2.ok, false);

    const r3 = await puente.procesarFila({ comando: 'quitar_server_cs', argumentos: { numero: 1 }, guild_id: 'g-web-1' }, client);
    assert.equal(r3.ok, true);
    assert.equal(store.getGuildConfig('g-web-1').servidores, undefined, 'la lista vacía limpia la rama');
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

  test('expone info del server, canales, roles y estadísticas por guild', () => {
    const client = clientFake();
    const guild = client.guilds.cache.get('g-web-1');
    // Canales y roles de muestra (lo que estadoBot lee del cache de Discord).
    guild.channels.cache.set('c-1', { id: 'c-1', name: 'general', type: 0 });
    guild.roles = { cache: new Map([['r-1', { id: 'r-1', name: 'Mod', hexColor: '#ff0000', position: 5 }]]) };

    const estado = puente.estadoBot(client);
    assert.ok(estado.bot, 'info del propio bot');
    assert.ok(estado.ia, 'estado de las IAs');
    assert.ok(estado.baseDatos, 'estado de la base');

    const g = estado.guilds[0];
    assert.equal(g.id, 'g-web-1');
    assert.equal(g.nombre, 'Server g-web-1');
    assert.equal(g.miembros, 42);
    assert.ok(Array.isArray(g.canales));
    assert.ok(g.canales.some((c) => c.id === 'c-1' && c.nombre === 'general'));
    assert.equal(g.roles[0].nombre, 'Mod');

    const stats = estado.estadisticas['g-web-1'];
    assert.ok(stats, 'bloque de estadísticas por guild');
    assert.ok(stats.niveles, 'stats de niveles');
    assert.ok(stats.warns);
    assert.ok(stats.afk);
    assert.ok(stats.interacciones);
    assert.ok(stats.antiSpamConfig, 'config de anti-spam con defaults aplicados');
  });
});
