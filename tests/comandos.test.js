// Tests de los comandos de moderación y de la mensajería compartida.
//
// Cubren las tres cosas que se arreglaron acá:
//   1. nunca se responde con el error genérico ni se pierde el caso del mod-log;
//   2. no se avisa por DM una sanción que Discord rechazó;
//   3. los mensajes salen siempre con el mismo formato (motivo, duración, caso #N).
//
// Fakes de Discord estilo objetos literales, como el resto de la suite.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-cmd-'));

const { accionEmbed, motivoTexto, marcaTiempo, textoDuracion } = require('../src/utils/replies');
const { diferir, quiereSilencioso, intentar } = require('../src/utils/acciones');
const { construirGuia, construirGuiaStaff } = require('../src/utils/guia');
const store = require('../src/store');

const kick = require('../src/commands/kick');
const ban = require('../src/commands/ban');
const timeout = require('../src/commands/timeout');
const warn = require('../src/commands/warn');
const clear = require('../src/commands/clear');
const warnings = require('../src/commands/warnings');
const comandoEmbed = require('../src/commands/embed');
const channelCreate = require('../src/events/channelCreate');

let contadorGuild = 0;

// ---------- Fakes ----------
function canalFake(id, { fallarEnvio = false } = {}) {
  const canal = {
    id,
    name: id,
    type: 0,
    manageable: true,
    rateLimitPerUser: 0,
    enviados: [],
    borradoEnBloque: [],
    send: async (payload) => {
      if (fallarEnvio) throw new Error('Missing Permissions');
      canal.enviados.push(payload);
      return { id: 'msg-1' };
    },
    messages: { fetch: async () => new Map() },
    bulkDelete: async (lista) => {
      canal.borradoEnBloque.push(...lista);
      return new Map(lista.map((m) => [m.id, m]));
    },
    permissionOverwrites: { edit: async () => {} },
    setRateLimitPerUser: async () => {},
    isTextBased: () => true,
  };
  return canal;
}

function miembroFake(id, { kickable = true, bannable = true, moderatable = true, manageable = true, position = 1 } = {}) {
  const m = {
    id,
    user: {
      id,
      tag: `${id}#0001`,
      username: id,
      displayAvatarURL: () => 'https://ejemplo.com/avatar.png',
    },
    displayName: id,
    kickable,
    bannable,
    moderatable,
    manageable,
    roles: { cache: new Map(), highest: { position } },
    permissions: { has: () => false },
    communicationDisabledUntilTimestamp: null,
    mensajesDirectos: [],
    kicks: [],
    baneos: [],
    timeouts: [],
    rolesAgregados: [],
    rolesQuitados: [],
  };
  // Los comandos le mandan el DM al USER (no al miembro): el mismo registro.
  m.user.send = async (texto) => {
    m.mensajesDirectos.push(texto);
  };
  m.kick = async (motivo) => {
    if (!kickable) throw new Error('Missing Permissions');
    m.kicks.push(motivo);
  };
  m.timeout = async (ms, motivo) => {
    if (!moderatable) throw new Error('Missing Permissions');
    m.timeouts.push({ ms, motivo });
  };
  m.roles.add = async (rol) => {
    m.rolesAgregados.push(rol);
  };
  return m;
}

function guildFake({ ownerId = 'dueno' } = {}) {
  contadorGuild += 1;
  const guild = {
    id: `g-cmd-${contadorGuild}`,
    name: 'TriGGer.Arena',
    ownerId,
    channels: { cache: new Map() },
    roles: { everyone: { id: '@everyone', name: '@everyone' }, cache: new Map() },
    members: { cache: new Map(), fetch: async (id) => guild.members.cache.get(id) ?? null, ban: async () => {}, unban: async () => {} },
    bans: { fetch: async () => new Map() },
  };
  const canalModlog = canalFake('modlog-1');
  guild.channels.cache.set('modlog-1', canalModlog);
  guild.canalModlog = canalModlog;
  store.escribir(guild.id, { modlog: 'modlog-1' });

  const yo = miembroFake('bot', { position: 99 });
  yo.permissions = { has: () => true };
  guild.members.me = yo;
  guild.members.cache.set('bot', yo);
  return guild;
}

function interaccionFake(guild, { opciones = {}, moderador = null, silencioso = false } = {}) {
  const member = moderador ?? miembroFake('mod-1', { position: 10 });
  const llamadas = { replies: [], edits: [], defers: [], seguimientos: [] };

  const pedir = (nombre, requerido) => {
    const valor = opciones[nombre];
    if (valor === undefined && requerido) throw new Error(`Falta la opción requerida ${nombre}`);
    return valor ?? null;
  };

  const interaction = {
    guild,
    guildId: guild.id,
    channelId: 'canal-1',
    channel: canalFake('canal-1'),
    user: { id: member.id, tag: `${member.id}#0001`, username: member.id },
    member,
    client: { user: { id: 'bot', tag: 'bot#0001' }, users: { fetch: async () => null } },
    deferred: false,
    replied: false,
    isButton: () => false,
    options: {
      getUser: (n) => pedir(n, false),
      getMember: (n) => opciones[`${n}_member`] ?? null,
      getString: (n, req) => pedir(n, req),
      getInteger: (n, req) => pedir(n, req),
      getBoolean: (n) => (n === 'silencioso' ? silencioso : (opciones[n] ?? null)),
      getChannel: (n) => opciones[n] ?? null,
      getSubcommand: () => opciones.sub ?? null,
    },
    async deferReply(payload) {
      interaction.deferred = true;
      llamadas.defers.push(payload);
    },
    async reply(payload) {
      interaction.replied = true;
      llamadas.replies.push(payload);
      return payload;
    },
    async editReply(payload) {
      llamadas.edits.push(payload);
      return payload;
    },
    async deleteReply() {},
    async followUp(payload) {
      llamadas.seguimientos.push(payload);
    },
  };

  return { interaction, llamadas };
}

// Moderador con permisos de moderación (para los comandos que validan staff).
function miembroConPermisos() {
  const m = miembroFake('mod-permisos', { position: 10 });
  m.permissions = { has: () => true };
  return m;
}

// Todo el texto visible del embed, footer incluido (ahí va el número de caso).
const textoDe = (embed) => {
  const data = embed.data ?? embed;
  return [data.title, data.description, ...(data.fields ?? []).map((f) => `${f.name}: ${f.value}`), data.footer?.text]
    .filter(Boolean)
    .join('\n');
};

// ---------- Mensajería compartida ----------
describe('mensajes de acciones (replies.js)', () => {
  test('accionEmbed arma la forma estándar: motivo, duración, caso y moderador', () => {
    const embed = accionEmbed({
      titulo: '👢 Expulsión',
      detalle: '<@1> fue expulsado.',
      motivo: 'flodeo',
      duracionTexto: '1 hora',
      caso: 7,
      moderador: 'Fede',
      thumbnail: 'https://ejemplo.com/a.png',
    });

    assert.equal(embed.data.title, '👢 Expulsión');
    assert.deepEqual(
      embed.data.fields.map((f) => f.name),
      ['Motivo', 'Duración']
    );
    assert.equal(embed.data.fields[0].value, 'flodeo');
    assert.match(embed.data.footer.text, /caso #7/);
    assert.match(embed.data.footer.text, /por Fede/);
    assert.equal(embed.data.thumbnail.url, 'https://ejemplo.com/a.png');
  });

  test('sin motivo dice "*No especificado*", nunca queda vacío ni con tres variantes', () => {
    assert.equal(motivoTexto(undefined), '*No especificado*');
    assert.equal(motivoTexto('   '), '*No especificado*');
    assert.equal(motivoTexto(' spam '), 'spam');
    assert.equal(accionEmbed({ motivo: '' }).data.fields[0].value, '*No especificado*');
  });

  test('marcaTiempo y textoDuracion generan los textos que Discord renderiza', () => {
    assert.match(marcaTiempo(0), /^<t:0:R>$/);
    assert.match(marcaTiempo(3_600_000), /^<t:3600:R>$/);
    assert.equal(textoDuracion(45 * 60 * 1000), '45 minutos');
    assert.equal(textoDuracion(60 * 60 * 1000), '1 hora');
    assert.equal(textoDuracion(28 * 86400 * 1000), '28 días');
    assert.equal(textoDuracion(90 * 1000), '1 minuto');
  });
});

describe('plomería de acciones (utils/acciones.js)', () => {
  test('diferir es idempotente y respeta el modo silencioso', async () => {
    const guild = guildFake();
    const { interaction, llamadas } = interaccionFake(guild);

    await diferir(interaction, false);
    await diferir(interaction, false);
    assert.equal(llamadas.defers.length, 1, 'no se difiere dos veces');
    assert.equal(llamadas.defers[0].flags, undefined, 'público por defecto');

    const { interaction: otra, llamadas: otrasLlamadas } = interaccionFake(guild, { silencioso: true });
    assert.equal(quiereSilencioso(otra), true);
    await diferir(otra, quiereSilencioso(otra));
    assert.equal(otrasLlamadas.defers[0].flags, 64, 'efímero cuando el staff lo pide');
  });

  test('intentar devuelve el resultado real de la operación', async () => {
    assert.deepEqual(await intentar('x', async () => {}), { ok: true });
    const fallo = await intentar('Discord rechazó el kick', async () => {
      throw new Error('Missing Permissions');
    });
    assert.equal(fallo.ok, false);
    assert.match(fallo.error, /Discord rechazó el kick: Missing Permissions/);
  });
});

// ---------- Acciones de moderación ----------
describe('/kick', () => {
  test('difiere antes de tocar la API, registra el caso y avisa por DM después', async () => {
    const guild = guildFake();
    const objetivo = miembroFake('user-1');
    guild.members.cache.set('user-1', objetivo);
    const { interaction, llamadas } = interaccionFake(guild, { opciones: { usuario: objetivo.user, razon: 'flodeo' } });

    // ¿La interacción ya estaba diferida cuando se llamó a la API de Discord?
    let deferidoAlExpulsar = null;
    const kickReal = objetivo.kick;
    objetivo.kick = async (motivo) => {
      deferidoAlExpulsar = interaction.deferred;
      return kickReal(motivo);
    };

    await kick.execute(interaction);

    assert.equal(llamadas.defers.length, 1, 'se difiere siempre');
    assert.equal(deferidoAlExpulsar, true, 'cuando la API se llamó, ya estábamos diferidos');
    assert.equal(objetivo.kicks.length, 1);
    assert.equal(llamadas.edits[0].embeds[0].data.fields[0].value, 'flodeo');
    assert.match(textoDe(llamadas.edits[0].embeds[0]), /caso #1/);

    const registro = guild.canalModlog.enviados[0].embeds[0].data;
    assert.match(registro.title, /Caso #1 — Expulsión \(kick\)/);
    assert.equal(objetivo.mensajesDirectos.length, 1, 'avisa por DM');
  });

  test('si Discord rechaza: error real, caso registrado como rechazado y sin DM', async () => {
    const guild = guildFake();
    const objetivo = miembroFake('user-2', { kickable: false });
    guild.members.cache.set('user-2', objetivo);
    // kickable false: motivoNoModerable no lo detecta, nuestro chequeo sí.
    const { interaction, llamadas } = interaccionFake(guild, {
      opciones: { usuario: objetivo.user, usuario_member: objetivo, razon: 'spam' },
    });

    await kick.execute(interaction);

    assert.equal(llamadas.defers.length, 0, 'valida antes de diferir cuando el miembro está en caché');
    assert.equal(llamadas.replies.length, 1);
    assert.match(textoDe(llamadas.replies[0].embeds[0]), /su rol está por encima del mío/);
    assert.equal(objetivo.mensajesDirectos.length, 0);
  });

  test('con `silencioso` la confirmación es efímera', async () => {
    const guild = guildFake();
    const objetivo = miembroFake('user-3');
    guild.members.cache.set('user-3', objetivo);
    const { interaction, llamadas } = interaccionFake(guild, {
      opciones: { usuario: objetivo.user },
      silencioso: true,
    });

    await kick.execute(interaction);
    assert.equal(llamadas.defers[0].flags, 64);
  });
});

describe('/ban', () => {
  test('registra el baneo y menciona la limpieza de mensajes', async () => {
    const guild = guildFake();
    const objetivo = miembroFake('user-4');
    guild.members.cache.set('user-4', objetivo);
    let baneado = null;
    guild.members.ban = async (id, opciones) => {
      baneado = { id, opciones };
    };
    const { interaction, llamadas } = interaccionFake(guild, {
      opciones: { usuario: objetivo.user, razon: 'raid', borrar_dias: 3 },
    });

    await ban.execute(interaction);

    assert.equal(baneado.id, 'user-4');
    assert.equal(baneado.opciones.deleteMessageSeconds, 3 * 86400);
    assert.match(textoDe(llamadas.edits[0].embeds[0]), /últimos \*\*3\*\* día/);
    assert.match(textoDe(llamadas.edits[0].embeds[0]), /caso #1/);
  });

  test('si Discord rechaza el baneo, no dice que baneó y deja el caso marcado', async () => {
    const guild = guildFake();
    const objetivo = miembroFake('user-5');
    guild.members.cache.set('user-5', objetivo);
    guild.members.ban = async () => {
      throw new Error('Missing Permissions');
    };
    const { interaction, llamadas } = interaccionFake(guild, { opciones: { usuario: objetivo.user } });

    await ban.execute(interaction);

    assert.match(textoDe(llamadas.edits[0].embeds[0]), /No se pudo banear/);
    assert.match(textoDe(llamadas.edits[0].embeds[0]), /Missing Permissions/);
    assert.equal(objetivo.mensajesDirectos.length, 0, 'no se avisa una sanción que no pasó');
    assert.match(guild.canalModlog.enviados[0].embeds[0].data.title, /rechazado/);
  });
});

describe('/timeout', () => {
  test('muestra cuándo termina el silencio y avisa por DM con marca de tiempo', async () => {
    const guild = guildFake();
    const objetivo = miembroFake('user-6');
    guild.members.cache.set('user-6', objetivo);
    const { interaction, llamadas } = interaccionFake(guild, {
      opciones: { usuario: objetivo.user, duracion: '1h', razon: 'flood' },
    });

    await timeout.execute(interaction);

    assert.equal(objetivo.timeouts[0].ms, 60 * 60 * 1000);
    const texto = textoDe(llamadas.edits[0].embeds[0]);
    assert.match(texto, /1 hora/);
    assert.match(texto, /termina <t:\d+:R>/, 'el staff ve la hora exacta de vencimiento');
    assert.match(objetivo.mensajesDirectos[0], /hasta <t:\d+:R>/);
  });

  test('la opción "Quitarlo ahora" levanta un silencio activo', async () => {
    const guild = guildFake();
    const objetivo = miembroFake('user-7');
    guild.members.cache.set('user-7', objetivo);
    const { interaction, llamadas } = interaccionFake(guild, {
      opciones: { usuario: objetivo.user, duracion: '0' },
    });

    await timeout.execute(interaction);

    assert.equal(objetivo.timeouts[0].ms, null, 'discord.js quita el timeout con null');
    assert.match(textoDe(llamadas.edits[0].embeds[0]), /Silencio levantado/);
    assert.match(guild.canalModlog.enviados[0].embeds[0].data.title, /Silencio levantado/);
  });
});

describe('/warn', () => {
  test('guarda la advertencia y muestra cuántas faltan', async () => {
    const guild = guildFake();
    const objetivo = miembroFake('user-8');
    guild.members.cache.set('user-8', objetivo);
    const { interaction, llamadas } = interaccionFake(guild, { opciones: { usuario: objetivo.user, razon: 'spam' } });

    await warn.execute(interaction);

    const texto = textoDe(llamadas.edits[0].embeds[0]);
    assert.match(texto, /advertido/);
    assert.match(texto, /quedan \*\*2\*\*/, 'faltan 2 para el silencio automático');
    assert.equal(objetivo.mensajesDirectos.length, 1);
  });

  test('si la escalada del 3er warn la rechaza Discord, NO dice que quedó silenciado', async () => {
    const guild = guildFake();
    const objetivo = miembroFake('user-9', { moderatable: true });
    guild.members.cache.set('user-9', objetivo);
    objetivo.timeout = async () => {
      throw new Error('Missing Permissions');
    };

    // Tres advertencias: la tercera dispara la escalada del silencio.
    let ultimas = null;
    for (let i = 0; i < 3; i++) {
      const { interaction, llamadas } = interaccionFake(guild, { opciones: { usuario: objetivo.user, razon: `motivo ${i}` } });
      await warn.execute(interaction);
      ultimas = llamadas;
    }

    const texto = textoDe(ultimas.edits[0].embeds[0]);
    assert.match(texto, /La escalada no se aplicó/);
    assert.match(texto, /Missing Permissions/);
    assert.ok(!/quedó silenciado 1 hora/i.test(texto), 'no puede afirmar un silencio que Discord rechazó');

    assert.ok(
      guild.canalModlog.enviados.some((e) => /Escalada fallida/.test(JSON.stringify(e.embeds[0].data))),
      'el mod-log registra que la escalada falló'
    );
  });
});

describe('/clear', () => {
  const mensajeFake = (id, autorId, antiguedadMs = 0) => ({
    id,
    author: { id: autorId },
    createdTimestamp: Date.now() - antiguedadMs,
    borrado: false,
    async delete() {
      this.borrado = true;
    },
  });

  test('con un solo mensaje usa delete (bulkDelete exige 2) y avisa al staff', async () => {
    const guild = guildFake();
    const mensaje = mensajeFake('m1', 'alguien');
    const { interaction, llamadas } = interaccionFake(guild, { opciones: { cantidad: 1 } });
    interaction.channel.messages.fetch = async () => new Map([['m1', mensaje]]);

    await clear.execute(interaction);

    assert.equal(mensaje.borrado, true, 'se borró el único mensaje');
    assert.equal(interaction.channel.borradoEnBloque.length, 0, 'no llamó a bulkDelete');
    assert.match(textoDe(llamadas.edits[0].embeds[0]), /Borré \*\*1\*\* mensaje/);
  });

  test('los mensajes de más de 14 días no se mandan a borrar y se informa cuántos quedaron', async () => {
    const guild = guildFake();
    const viejo = mensajeFake('viejo', 'alguien', 20 * 86400_000);
    const nuevoA = mensajeFake('nuevo-a', 'alguien');
    const nuevoB = mensajeFake('nuevo-b', 'alguien');
    const { interaction, llamadas } = interaccionFake(guild, { opciones: { cantidad: 5 } });
    interaction.channel.messages.fetch = async () =>
      new Map([
        ['viejo', viejo],
        ['nuevo-a', nuevoA],
        ['nuevo-b', nuevoB],
      ]);

    await clear.execute(interaction);

    assert.equal(viejo.borrado, false, 'los viejos no se tocan');
    assert.deepEqual(interaction.channel.borradoEnBloque.map((m) => m.id), ['nuevo-a', 'nuevo-b']);
    assert.match(textoDe(llamadas.edits[0].embeds[0]), /Quedaron afuera/);
  });

  test('si Discord rechaza el borrado, lo dice con el motivo real', async () => {
    const guild = guildFake();
    const { interaction, llamadas } = interaccionFake(guild, { opciones: { cantidad: 5 } });
    interaction.channel.messages.fetch = async () =>
      new Map([
        ['a', mensajeFake('a', 'x')],
        ['b', mensajeFake('b', 'x')],
      ]);
    interaction.channel.bulkDelete = async () => {
      throw new Error('Missing Permissions');
    };

    await clear.execute(interaction);

    assert.match(textoDe(llamadas.edits[0].embeds[0]), /No se aplicó el borrado/);
    assert.match(textoDe(llamadas.edits[0].embeds[0]), /Missing Permissions/);
  });
});

describe('/warnings', () => {
  test('con muchas advertencias pagina y respeta el límite de 1024 por campo', async () => {
    const guild = guildFake();
    const { addWarn } = require('../src/warns');
    for (let i = 1; i <= 12; i++) {
      addWarn(guild.id, 'user-10', { reason: `motivo número ${i} con algo de texto`, moderatorId: 'mod-1', timestamp: Date.now() });
    }

    const { interaction, llamadas } = interaccionFake(guild, {
      opciones: { usuario: { id: 'user-10', tag: 'user-10#0001', displayAvatarURL: () => 'https://x/a.png' } },
      moderador: miembroConPermisos(),
    });
    await warnings.execute(interaction);

    const embed = llamadas.replies[0].embeds[0].data;
    for (const campo of embed.fields) {
      assert.ok(campo.value.length <= 1024, `campo de ${campo.value.length} caracteres (Discord corta en 1024)`);
    }
    assert.match(embed.footer.text, /página/i);
    assert.equal(llamadas.replies[0].components.length, 1, 'botones de página');
  });

  test('el botón de página actualiza el mismo mensaje', async () => {
    const guild = guildFake();
    const { addWarn } = require('../src/warns');
    for (let i = 1; i <= 12; i++) {
      addWarn(guild.id, 'user-11', { reason: `motivo ${i}`, moderatorId: 'mod-1', timestamp: Date.now() });
    }

    const { interaction } = interaccionFake(guild, { moderador: miembroConPermisos() });
    interaction.options.getUser = () => ({ id: 'user-11', tag: 'user-11#0001', displayAvatarURL: () => 'https://x/a.png' });
    interaction.isButton = () => true;
    const actualizaciones = [];
    interaction.update = async (payload) => actualizaciones.push(payload);

    await warnings.ejecutar(interaction, { id: 'user-11', tag: 'user-11#0001', displayAvatarURL: () => 'https://x/a.png' }, 2);

    assert.equal(actualizaciones.length, 1);
    assert.match(actualizaciones[0].embeds[0].data.footer.text, /página 2/);
  });
});

// ---------- Mensajería de staff ----------
describe('/embed', () => {
  test('si no puede publicar, no dice "enviado"', async () => {
    const guild = guildFake();
    const destino = canalFake('anuncios', { fallarEnvio: true });
    guild.channels.cache.set('anuncios', destino);
    const { interaction, llamadas } = interaccionFake(guild, {
      opciones: { titulo: 'Torneo', texto: 'Arranca el sábado', canal: destino },
    });

    await comandoEmbed.execute(interaction);

    const texto = textoDe(llamadas.edits[0].embeds[0]);
    assert.match(texto, /El anuncio no se publicó/);
    assert.ok(!/Anuncio enviado/.test(texto));
  });
});

describe('guía de /help', () => {
  const clientFake = () => ({
    user: { username: 'Trigger' },
    commands: new Map([
      ['help', { data: { name: 'help', description: 'Guía' } }],
      ['ban', { data: { name: 'ban', description: 'Banea' } }],
      ['top', { data: { name: 'top', description: 'Ranking' } }],
      ['comando-nuevo', { data: { name: 'comando-nuevo', description: 'Recién agregado' } }],
    ]),
  });

  test('todo comando cargado aparece en alguna guía (no se desincroniza)', () => {
    const client = clientFake();
    const publica = JSON.stringify(construirGuia(client).data);
    const staff = JSON.stringify(construirGuiaStaff(client).data);

    for (const nombre of client.commands.keys()) {
      assert.match(staff, new RegExp(`/${nombre}`), `falta /${nombre} en la guía de staff`);
    }
    // Un comando nuevo sin categoría aparece igual, en «Otros».
    assert.match(staff, /Otros/);
    assert.match(publica, /comando-nuevo/);
  });

  test('la guía pública no muestra los comandos de staff', () => {
    const publica = JSON.stringify(construirGuia(clientFake()).data);
    assert.ok(!/\/ban/.test(publica), 'no filtra comandos de moderación');
  });
});

// ---------- Rol Silenciado en canales nuevos ----------
describe('evento channelCreate', () => {
  test('aplica el silencio a un canal creado después del rol', async () => {
    const guild = guildFake();
    store.escribir(guild.id, { modlog: 'modlog-1', muteRole: 'rol-mute' });

    const aplicados = [];
    const canal = {
      id: 'canal-nuevo',
      name: 'general-2',
      type: 0,
      guild,
      manageable: true,
      permissionOverwrites: {
        edit: async (rolId, permisos) => aplicados.push({ rolId, permisos }),
      },
    };

    await channelCreate.execute(canal);

    assert.equal(aplicados.length, 1);
    assert.equal(aplicados[0].rolId, 'rol-mute');
    assert.equal(aplicados[0].permisos.SendMessages, false);
    assert.equal(aplicados[0].permisos.Speak, false);
  });

  test('sin rol de silencio configurado no toca nada', async () => {
    const guild = guildFake();
    let llamado = false;
    const canal = {
      id: 'canal-x',
      name: 'x',
      type: 0,
      guild,
      manageable: true,
      permissionOverwrites: {
        edit: async () => {
          llamado = true;
        },
      },
    };

    await channelCreate.execute(canal);
    assert.equal(llamado, false);
  });
});
