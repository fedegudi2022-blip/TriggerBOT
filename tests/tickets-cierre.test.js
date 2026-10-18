// Tests del transcript HTML, el motivo de cierre y el auto-cierre por inactividad.
// Sin red: Discord queda mockeado con objetos literales y cada test usa su guild.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-tickets-cierre-'));

const tickets = require('../src/utils/tickets');
const ticketCmd = require('../src/commands/ticket');
const store = require('../src/store');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

let contador = 0;

function coleccion(items = []) {
  const map = new Map(items);
  map.last = () => [...map.values()][map.size - 1];
  map.find = (fn) => [...map.values()].find(fn);
  return map;
}

function guildFake() {
  contador += 1;
  const guild = {
    id: `g-cierre-${contador}`,
    name: 'Server de prueba',
    ownerId: 'dueno-1',
    roles: { cache: new Map(), everyone: { id: 'rol-everyone' } },
    channels: { cache: coleccion(), create: null },
    members: { cache: coleccion(), me: { id: 'bot-1', permissions: { has: () => true } }, fetch: async () => null },
    client: {
      user: { id: 'bot-1', username: 'TriggerBOT' },
      users: { fetch: async () => ({ send: async () => ({ id: 'dm' }) }) },
    },
  };
  return guild;
}

function canalFake(guild, { topic = null, name = 'soporte-001', mensajes = null } = {}) {
  const canal = {
    id: `canal-${contador}-${guild.channels.cache.size + 1}`,
    name,
    topic: topic ?? `${guild.id}:user-1:001:soporte`,
    enviados: [],
    deleted: false,
    messages: {
      fetch: async () =>
        coleccion(
          mensajes ?? [
            [
              'm1',
              {
                id: 'm1',
                createdTimestamp: Date.now() - 60_000,
                author: { username: 'fede' },
                content: 'hola <script>alert(1)</script>',
                attachments: new Map([['a1', { url: 'https://ejemplo.com/prueba.png' }]]),
                embeds: [],
              },
            ],
          ]
        ),
    },
  };
  canal.send = async (payload) => {
    canal.enviados.push(payload);
    return { id: `msg-${canal.enviados.length}` };
  };
  canal.delete = async () => {
    canal.deleted = true;
  };
  canal.guild = guild;
  guild.channels.cache.set(canal.id, canal);
  return canal;
}

function miembroStaff(guild, id = 'staff-1') {
  const member = {
    id,
    guild,
    user: { id, username: `staff-${id}` },
    permissions: { has: (p) => p === PermissionFlagsBits.ManageGuild },
    roles: { cache: { has: () => false } },
  };
  guild.members.cache.set(id, member);
  return member;
}

function interaccionFake(canal, { customId = 'ticket:cerrar', user, member, tipo = 'button', values = [] } = {}) {
  const llamadas = { replies: [], updates: [] };
  return {
    channel: canal,
    guild: canal.guild,
    guildId: canal.guild.id,
    client: canal.guild.client,
    user: user ?? member?.user ?? { id: 'user-1', username: 'fede' },
    member: member ?? null,
    customId,
    values,
    isButton: () => tipo === 'button',
    isStringSelectMenu: () => tipo === 'select',
    async reply(p) {
      llamadas.replies.push(p);
      return p;
    },
    async update(p) {
      llamadas.updates.push(p);
      return p;
    },
    llamadas,
  };
}

function cierreListo({ motivo = 'Resuelto', motivoClave = 'resuelto' } = {}) {
  const guild = guildFake();
  const logs = {
    id: 'canal-logs',
    enviados: [],
    send: async (p) => {
      logs.enviados.push(p);
      return { id: 'l' };
    },
  };
  guild.channels.cache.set(logs.id, logs);
  const canal = canalFake(guild);
  store.escribir(guild.id, {
    tickets: {
      canalLogs: logs.id,
      activos: { [canal.id]: { numero: '001', userId: 'user-1', tipo: 'soporte', ts: Date.now() - 90_000, reclamadoPor: 'staff-1' } },
    },
  });
  return { guild, canal, logs, motivo, motivoClave };
}

describe('transcript HTML', () => {
  test('escapa el contenido y muestra autor, hora y adjuntos', () => {
    const html = tickets
      .partesTranscriptHtml(
        [
          {
            id: 'm1',
            ts: Date.now(),
            autor: '<Fede>',
            avatar: 'https://cdn.discordapp.com/avatar.png',
            contenido: 'hola <script>alert(1)</script> & chau',
            adjuntos: ['https://ejemplo.com/prueba.png', 'javascript:alert(1)'],
            embeds: [{ titulo: 'Prueba', descripcion: 'detalle <b>' }],
          },
        ],
        {
          guildNombre: 'Server',
          canalNombre: 'soporte-001',
          numero: '001',
          tipo: 'Soporte',
          abiertoPor: 'user-1',
          atendidoPor: 'staff-1',
          cerradoPor: 'staff',
          motivo: 'Resuelto',
          integro: true,
          parcial: false,
        }
      )[0];

    assert.equal(partesName(html), 'transcript-soporte-001.html');
    const texto = html.attachment.toString('utf8');
    assert.match(texto, /&lt;Fede&gt;/);
    assert.match(texto, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; chau/);
    assert.ok(!texto.includes('<script>alert'), 'el script no se inyecta');
    assert.match(texto, /https:\/\/ejemplo\.com\/prueba\.png/);
    assert.ok(!texto.includes('javascript:alert'), 'los enlaces no http(s) se descartan');
    assert.match(texto, /detalle &lt;b&gt;/);
    assert.match(texto, /Motivo: <b>Resuelto<\/b>/);
  });

  test('parte el HTML por mensaje sin superar el límite de adjuntos', () => {
    const mensajes = Array.from({ length: 9 }, (_, i) => ({
      id: `m${i}`,
      ts: Date.now(),
      autor: 'Fede',
      avatar: null,
      contenido: 'x'.repeat(1_000_000),
      adjuntos: [],
      embeds: [],
    }));
    const partes = tickets.partesTranscriptHtml(mensajes, {
      guildNombre: 'Server',
      canalNombre: 'soporte-001',
      numero: '001',
      tipo: 'Soporte',
      abiertoPor: 'user-1',
      atendidoPor: 'staff-1',
      cerradoPor: 'staff',
      motivo: 'Resuelto',
      integro: true,
      parcial: false,
    });

    assert.ok(partes.length > 1);
    for (const parte of partes) assert.ok(parte.attachment.length <= tickets.LIMITE_ADJUNTO_BYTES);
    assert.match(partes[0].name, /parte-1\.html$/);
    assert.match(partes[1].name, /parte-2\.html$/);
  });
});

function partesName(parte) {
  return parte.name;
}

describe('cierre con motivo', () => {
  test('adjunta el HTML, deja el motivo en el resumen, el log y el historial', async () => {
    const { guild, canal, logs, motivo, motivoClave } = cierreListo();

    const ok = await tickets.cerrarCanal(canal, { id: 'staff-1', username: 'staff' }, { graciaMs: 0, motivo, motivoClave });

    assert.equal(ok, true);
    assert.equal(canal.deleted, true);
    assert.match(canal.enviados.at(-1).embeds[0].data.description, /\*\*Motivo:\*\* Resuelto/);
    assert.match(logs.enviados[0].embeds[0].data.description, /\*\*Motivo:\*\* Resuelto/);
    assert.match(logs.enviados[0].files[0].name, /\.html$/);

    const cierre = store.leer(guild.id).tickets.cierres.at(-1);
    assert.equal(cierre.motivo, 'Resuelto');
    assert.equal(cierre.motivoClave, 'resuelto');
    assert.equal(cierre.atendidoPor, 'staff-1');
  });

  test('el botón Cerrar pregunta el motivo antes de cerrar', async () => {
    const { guild, canal } = cierreListo();
    const staff = miembroStaff(guild);
    const ix = interaccionFake(canal, { member: staff });

    await tickets.manejarBotonTicket(ix);

    const select = ix.llamadas.replies[0].components[0].toJSON().components[0];
    assert.equal(select.custom_id, 'ticket:motivo');
    assert.deepEqual(select.options.map((o) => o.value), ['resuelto', 'no_resuelto', 'duplicado', 'otro']);
    assert.equal(canal.deleted, false, 'todavía no cerró');
  });

  test('el motivo elegido viaja al cierre', async () => {
    const { guild, canal } = cierreListo();
    const staff = miembroStaff(guild);
    const ix = interaccionFake(canal, { customId: 'ticket:motivo', tipo: 'select', values: ['duplicado'], member: staff });

    // El cierre espera 30 s antes de borrar el canal; acá se acorta para no frenar la
    // suite (el comportamiento de la gracia se prueba en los tests de cerrarCanal).
    const timeoutOriginal = global.setTimeout;
    global.setTimeout = (fn) => timeoutOriginal(fn, 0);
    try {
      await tickets.manejarSelectTicket(ix);
    } finally {
      global.setTimeout = timeoutOriginal;
    }

    assert.match(ix.llamadas.updates[0].content, /Duplicado/);
    assert.equal(canal.deleted, true);
    assert.equal(store.leer(guild.id).tickets.cierres.at(-1).motivoClave, 'duplicado');
  });
});

describe('/ticket inactividad y /ticket stats', () => {
  function comandoFake(guild, { sub, horas = null } = {}) {
    const llamadas = { replies: [] };
    const member = miembroStaff(guild);
    return {
      guild,
      user: member.user,
      member,
      options: {
        getSubcommand: () => sub,
        getInteger: () => horas,
        getString: () => null,
        getChannel: () => null,
      },
      reply: async (p) => {
        llamadas.replies.push(p);
        return p;
      },
      deferReply: async () => {},
      editReply: async (p) => {
        llamadas.replies.push(p);
        return p;
      },
      llamadas,
    };
  }

  test('horas:0 se guarda como apagado (no como el default de 72)', async () => {
    const guild = guildFake();
    store.escribir(guild.id, {});
    await ticketCmd.execute(comandoFake(guild, { sub: 'inactividad', horas: 0 }));
    assert.equal(store.leer(guild.id).tickets.horasInactividad, 0);
  });

  test('stats muestra promedio, staff y motivos', async () => {
    const guild = guildFake();
    store.escribir(guild.id, {
      tickets: {
        calificaciones: [
          { numero: '001', userId: 'u1', staffId: 'staff-1', valor: 5, ts: Date.now() },
          { numero: '002', userId: 'u2', staffId: 'staff-1', valor: 3, ts: Date.now() },
        ],
        cierres: [
          { numero: '001', motivo: 'Resuelto', motivoClave: 'resuelto' },
          { numero: '002', motivo: 'Duplicado', motivoClave: 'duplicado' },
          { numero: '003', motivo: 'Cierre automático por inactividad', motivoClave: 'inactividad' },
        ],
      },
    });
    const ix = comandoFake(guild, { sub: 'stats' });

    await ticketCmd.execute(ix);

    const embed = ix.llamadas.replies[0].embeds[0].data;
    assert.match(embed.title, /Estadísticas de tickets/);
    assert.match(embed.description, /4\.00\/5 sobre \*\*2\*\* encuesta/);
    const campos = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.match(campos['Calificación por staff'], /<@staff-1> — \*\*4\.0\/5\*\* \(2 encuestas\)/);
    assert.match(campos['Motivos de cierre'], /Resuelto\*\*: 1/);
    assert.match(campos['Motivos de cierre'], /Inactividad\*\*: 1/);
  });
});

describe('auto-cierre por inactividad', () => {
  const AHORA = 1_800_000_000_000;

  function conTicket({ horasSinActividad = 73, horasInactividad = null, canalPresente = true } = {}) {
    const guild = guildFake();
    const logs = {
      id: 'canal-logs',
      enviados: [],
      send: async (p) => {
        logs.enviados.push(p);
        return { id: 'l' };
      },
    };
    guild.channels.cache.set(logs.id, logs);
    const canal = canalFake(guild);
    const canalId = canalPresente ? canal.id : 'canal-borrado';
    const base = AHORA - horasSinActividad * 3_600_000;
    store.escribir(guild.id, {
      tickets: {
        canalLogs: logs.id,
        ...(horasInactividad === null ? {} : { horasInactividad }),
        activos: {
          [canalId]: {
            numero: '001',
            userId: 'user-1',
            tipo: 'soporte',
            ts: base - 60_000,
            ultimaActividad: base,
          },
        },
      },
    });
    const client = { user: { id: 'bot-1', username: 'TriggerBOT' }, guilds: { cache: new Map([[guild.id, guild]]) } };
    return { guild, canal, logs, client, canalId };
  }

  test('avisa una hora antes y no cierra todavía', async () => {
    const { guild, canal, client } = conTicket({ horasSinActividad: 71.5 });

    const resumen = await tickets.procesarInactividad(client, { ahora: AHORA, graciaMs: 0 });

    assert.equal(resumen.avisados, 1);
    assert.equal(resumen.cerrados, 0);
    assert.equal(canal.deleted, false);
    assert.match(canal.enviados.at(-1).embeds[0].data.title, /cierra por inactividad/);
    assert.equal(tickets.activoDe(guild.id, canal.id).avisoInactividad, true);
  });

  test('al vencer el plazo cierra, guarda el motivo y limpia el ticket activo', async () => {
    const { guild, canal, client } = conTicket({ horasSinActividad: 73 });

    const resumen = await tickets.procesarInactividad(client, { ahora: AHORA, graciaMs: 0 });

    assert.equal(resumen.cerrados, 1);
    assert.equal(canal.deleted, true);
    assert.equal(tickets.activoDe(guild.id, canal.id), null);
    const cierre = store.leer(guild.id).tickets.cierres.at(-1);
    assert.equal(cierre.motivoClave, 'inactividad');
    assert.match(cierre.motivo, /inactividad/i);
  });

  test('un mensaje nuevo reinicia el reloj y borra el aviso', async () => {
    const { guild, canal, client } = conTicket({ horasSinActividad: 71.5 });
    await tickets.procesarInactividad(client, { ahora: AHORA, graciaMs: 0 });

    assert.equal(tickets.registrarActividad(canal, { ahora: AHORA }), true);
    const activo = tickets.activoDe(guild.id, canal.id);
    assert.equal(activo.avisoInactividad, false);
    assert.equal(activo.ultimaActividad, AHORA);

    const resumen = await tickets.procesarInactividad(client, { ahora: AHORA + 3_600_000, graciaMs: 0 });
    assert.equal(resumen.cerrados, 0);
    assert.equal(resumen.avisados, 0);
  });

  test('con 0 horas el auto-cierre está apagado', async () => {
    const { canal, client } = conTicket({ horasInactividad: 0 });

    const resumen = await tickets.procesarInactividad(client, { ahora: AHORA, graciaMs: 0 });

    assert.equal(resumen.cerrados, 0);
    assert.equal(canal.deleted, false);
  });

  test('un registro sin canal se limpia sin intentar cerrar', async () => {
    const { guild, client } = conTicket({ canalPresente: false });

    const resumen = await tickets.procesarInactividad(client, { ahora: AHORA, graciaMs: 0 });

    assert.equal(resumen.limpiados, 1);
    assert.equal(store.leer(guild.id).tickets.activos, undefined, 'sin activos no queda la clave vacía');
  });
});
