// Tests de src/utils/proteccion.js — detección de spam/raid y acciones con resultado real.
// Sin base de datos configurada: la capa de sync queda en no-op y nada toca la red.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-proteccion-'));

const store = require('../src/store');
const proteccion = require('../src/utils/proteccion');

// ---------- Fábricas ----------
function guildFake(id, { permisosBot = [], muteRole = null } = {}) {
  const guild = {
    id,
    ownerId: `owner-${id}`,
    members: {
      me: {
        id: 'bot-1',
        roles: { highest: { position: 100 } },
        permissions: { has: (p) => permisosBot.includes(p) },
      },
      cache: new Map(),
    },
    channels: { cache: new Map() }, // sin canales: alertas y modlog quedan en no-op
    roles: { cache: new Map(muteRole ? [[muteRole, { id: muteRole }]] : []) },
    client: { user: { id: 'bot-1' } },
  };
  return guild;
}

function miembroFake(id, guild, { posicionRol = 1, creado = Date.now(), rolesCacheSize = 1, fallaTimeout = null } = {}) {
  return {
    id,
    guild,
    user: { id, tag: `usuario-${id}`, bot: false, createdTimestamp: creado, send: async () => {} },
    permissions: { has: () => false },
    roles: {
      highest: { position: posicionRol },
      cache: { size: rolesCacheSize },
      add: async () => {},
    },
    timeout: async () => {
      if (fallaTimeout) throw fallaTimeout;
    },
    kick: async () => {},
    ban: async () => {},
  };
}

function mensajeFake(id, guild, member, extra = {}) {
  return {
    id,
    guildId: guild.id,
    channelId: 'canal-1',
    guild,
    member,
    author: member.user,
    content: '',
    mentions: { everyone: false, users: { size: 0 }, roles: { size: 0 } },
    ...extra,
  };
}

function activar(guildId, extras = {}) {
  store.setGuildConfig(guildId, (c) => {
    c.proteccion = { activado: true, ...extras };
  });
}

beforeEach(() => proteccion.resetear());

// ---------- Anti-spam ----------
describe('procesarMensajeParaSpam', () => {
  test('no actúa si la protección está desactivada', async () => {
    const guild = guildFake('g-spam-off');
    const member = miembroFake('u-1', guild);
    store.setGuildConfig(guild.id, (c) => {
      c.proteccion = { activado: false };
    });
    for (let i = 0; i < 6; i++) {
      const r = await proteccion.procesarMensajeParaSpam(mensajeFake(`m${i}`, guild, member));
      assert.equal(r, false);
    }
  });

  test('exime al staff con permiso de gestionar mensajes', async () => {
    const guild = guildFake('g-spam-staff');
    activar(guild.id, { spamMensajes: 3, spamSegundos: 10 });
    const staff = miembroFake('staff-1', guild);
    staff.permissions.has = (p) => p === PermissionFlagsBits.ManageMessages;
    for (let i = 0; i < 6; i++) {
      const r = await proteccion.procesarMensajeParaSpam(mensajeFake(`m${i}`, guild, staff));
      assert.equal(r, false);
    }
  });

  test('detecta el flood y actúa (acción "aviso")', async () => {
    const guild = guildFake('g-spam-on');
    activar(guild.id, { accionSpam: 'aviso', spamMensajes: 3, spamSegundos: 10 });
    const member = miembroFake('u-2', guild);

    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m1', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m2', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m3', guild, member)), true);
  });

  test('respeta la ventana de segundos (mensajes lentos no son spam)', async () => {
    const guild = guildFake('g-spam-ventana');
    activar(guild.id, { accionSpam: 'aviso', spamMensajes: 3, spamSegundos: 2 });
    const member = miembroFake('u-3', guild);

    const t = Date.now();
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m1', guild, member)), false);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m2', guild, member)), false);
    await new Promise((r) => setTimeout(r, 2100)); // el 1er y 2do mensaje ya salieron de la ventana
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m3', guild, member)), false);
  });

  test('respeta umbrales por encima de 10 (rango completo 3-20)', async () => {
    const guild = guildFake('g-spam-rango');
    activar(guild.id, { accionSpam: 'aviso', spamMensajes: 12, spamSegundos: 60 });
    const member = miembroFake('u-rango', guild);

    for (let i = 1; i <= 11; i++) {
      assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake(`m${i}`, guild, member)), false, `el mensaje ${i} no debería disparar`);
    }
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m12', guild, member)), true, 'el mensaje 12 cruza el umbral');
  });

  test('solo cuenta y borra los mensajes dentro de la ventana', async () => {
    const guild = guildFake('g-spam-poda', { permisosBot: [PermissionFlagsBits.ManageMessages] });
    activar(guild.id, { accionSpam: 'aviso', spamMensajes: 3, spamSegundos: 1 });
    // Canal con bulkDelete que registra qué ids se borran.
    const borrados = [];
    guild.channels.cache.set('canal-1', {
      id: 'canal-1',
      bulkDelete: async (ids) => {
        borrados.push(...ids);
        return new Map(ids.map((id) => [id, {}]));
      },
    });
    const member = miembroFake('u-poda', guild);

    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m1', guild, member)), false);
    await new Promise((r) => setTimeout(r, 1500)); // m1 sale de la ventana de 1 s
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m2', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m3', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m4', guild, member)), true);
    assert.deepEqual(borrados, ['m2', 'm3', 'm4'], 'no se borra el mensaje viejo fuera de la ventana');
  });

  test('la notificación describe el resultado real cuando la acción falla', async () => {
    const guild = guildFake('g-spam-dm'); // el bot NO tiene permisos
    activar(guild.id, { accionSpam: 'timeout', spamMensajes: 3, spamSegundos: 60 });
    const member = miembroFake('u-dm', guild);
    const dms = [];
    member.user.send = async (texto) => {
      dms.push(texto);
    };

    await proteccion.procesarMensajeParaSpam(mensajeFake('m1', guild, member));
    await proteccion.procesarMensajeParaSpam(mensajeFake('m2', guild, member));
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m3', guild, member)), true);

    assert.equal(dms.length, 1);
    assert.match(dms[0], /Me falta el permiso/, 'avisa que la acción no se pudo aplicar');
    assert.doesNotMatch(dms[0], /Acción aplicada/, 'no anuncia la acción configurada como si se hubiera aplicado');
  });

  test('no castiga dos veces al mismo usuario dentro del cooldown', async () => {
    const guild = guildFake('g-spam-cooldown');
    activar(guild.id, { accionSpam: 'aviso', spamMensajes: 3, spamSegundos: 60 });
    const member = miembroFake('u-4', guild);

    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m1', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m2', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m3', guild, member)), true, 'el 3er mensaje cruza el umbral y castiga');
    // Dentro del cooldown de 30 s no vuelve a castigar aunque siga superando el umbral.
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m4', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m5', guild, member)), false);
    assert.equal(await proteccion.procesarMensajeParaSpam(mensajeFake('m6', guild, member)), false);
  });
});

// ---------- Acciones con resultado real ----------
describe('ejecutarAccion y aplicarMute', () => {
  test('timeout exitoso reporta el resultado real', async () => {
    const guild = guildFake('g-acc-1', { permisosBot: [PermissionFlagsBits.ModerateMembers] });
    const member = miembroFake('u-1', guild);
    const texto = await proteccion.ejecutarAccion(member, 'timeout', 'razón', 'spam');
    assert.equal(texto, 'timeout de 10 min');
  });

  test('timeout rechazado por permisos NO miente sobre el resultado', async () => {
    const guild = guildFake('g-acc-2', { permisosBot: [] }); // bot sin ModerateMembers
    const member = miembroFake('u-1', guild);
    const texto = await proteccion.ejecutarAccion(member, 'timeout', 'razón', 'spam');
    assert.match(texto, /⚠️ timeout falló: Me falta el permiso/);
  });

  test('baneo rechazado por Discord reporta el error concreto', async () => {
    const guild = guildFake('g-acc-3', { permisosBot: [PermissionFlagsBits.BanMembers] });
    const member = miembroFake('u-1', guild);
    member.ban = async () => {
      throw new Error('falta jerarquía');
    };
    const texto = await proteccion.ejecutarAccion(member, 'ban', 'razón', 'spam');
    assert.match(texto, /⚠️ Discord rechazó el baneo: falta jerarquía/);
  });

  test('aplicarMute con rol configurado: asigna el rol de verdad', async () => {
    const guild = guildFake('g-acc-4', { permisosBot: [PermissionFlagsBits.ManageRoles], muteRole: 'rol-mute' });
    store.setGuildConfig(guild.id, (c) => {
      c.muteRole = 'rol-mute';
    }); // el rol viene de la config del server
    const member = miembroFake('u-1', guild);
    let rolAsignado = false;
    member.roles.add = async () => {
      rolAsignado = true;
    };
    const res = await proteccion.aplicarMute(member, 'razón');
    assert.deepEqual(res, { ok: true, fallback: false });
    assert.equal(rolAsignado, true);
  });

  test('aplicarMute sin rol configurado: aplica timeout REAL como fallback', async () => {
    const guild = guildFake('g-acc-5', { permisosBot: [PermissionFlagsBits.ModerateMembers] });
    const member = miembroFake('u-1', guild);
    let timeoutAplicado = false;
    member.timeout = async () => {
      timeoutAplicado = true;
    };
    const res = await proteccion.aplicarMute(member, 'razón');
    assert.deepEqual(res, { ok: true, fallback: true });
    assert.equal(timeoutAplicado, true, 'el fallback debe EJECUTAR el timeout, no solo anunciarlo');
  });

  test('aplicarMute sin rol y sin permiso de timeout: falla honestamente', async () => {
    const guild = guildFake('g-acc-6', { permisosBot: [] });
    const member = miembroFake('u-1', guild);
    const res = await proteccion.aplicarMute(member, 'razón');
    assert.equal(res.ok, false);
    assert.match(res.error, /Me falta el permiso/);
  });
});

// ---------- Anti-raid ----------
describe('registrarIngreso (anti-raid)', () => {
  test('auto-acción solo sobre cuentas nuevas sin roles; el resto queda a salvo', async () => {
    const guild = guildFake('g-raid-1', { permisosBot: [PermissionFlagsBits.KickMembers] });
    store.setGuildConfig(guild.id, (c) => {
      c.proteccion = { activado: true, raidJoins: 5, raidSegundos: 60, accionesRapidas: true, accionRaid: 'kick' };
    });

    let expulsados = 0;
    const hacerMiembro = (id, { viejo = false, conRoles = false, bot = false } = {}) => {
      const m = miembroFake(id, guild, {
        creado: viejo ? Date.now() - 30 * 86400_000 : Date.now(),
        rolesCacheSize: conRoles ? 3 : 1,
      });
      m.user.bot = bot;
      m.kick = async () => {
        expulsados += 1;
      };
      guild.members.cache.set(id, m);
      return m;
    };

    // Mezcla: 2 cuentas nuevas calificadas + bot + cuenta con roles ya asignados.
    await proteccion.registrarIngreso(hacerMiembro('nuevo-A'));
    await proteccion.registrarIngreso(hacerMiembro('nuevo-B'));
    await proteccion.registrarIngreso(hacerMiembro('bot-raid', { bot: true }));
    await proteccion.registrarIngreso(hacerMiembro('con-roles', { conRoles: true }));
    assert.equal(expulsados, 0, 'no actúa antes de alcanzar el umbral de ingresos');

    // El 5º ingreso cruza el umbral: la oleada entera se evalúa de una vez.
    await proteccion.registrarIngreso(hacerMiembro('nuevo-C'));
    assert.equal(expulsados, 3, 'solo las 3 cuentas nuevas sin roles fueron expulsadas');

    // Los que no calificaron siguen en el servidor.
    assert.ok(guild.members.cache.has('bot-raid'));
    assert.ok(guild.members.cache.has('con-roles'));
  });

  test('con auto-acción apagada: alerta sin expulsar a nadie', async () => {
    const guild = guildFake('g-raid-2', { permisosBot: [PermissionFlagsBits.KickMembers] });
    store.setGuildConfig(guild.id, (c) => {
      c.proteccion = { activado: true, raidJoins: 2, raidSegundos: 60, accionesRapidas: false, accionRaid: 'kick' };
    });

    let expulsados = 0;
    const hacerMiembro = (id) => {
      const m = miembroFake(id, guild);
      m.kick = async () => {
        expulsados += 1;
      };
      guild.members.cache.set(id, m);
      return m;
    };

    await proteccion.registrarIngreso(hacerMiembro('n-1'));
    await proteccion.registrarIngreso(hacerMiembro('n-2'));
    await proteccion.registrarIngreso(hacerMiembro('n-3'));
    assert.equal(expulsados, 0);
  });
});

// ---------- Automod por contenido ----------
describe('procesarMensajeParaFiltros — automod por contenido', () => {
  // Guild con permisos de borrado y un canal que registra qué ids se borran.
  function guildConBorrado(id) {
    const guild = guildFake(id, { permisosBot: [PermissionFlagsBits.ManageMessages] });
    const borrados = [];
    guild.channels.cache.set('canal-1', {
      id: 'canal-1',
      bulkDelete: async (ids) => {
        borrados.push(...ids);
        return new Map(ids.map((i) => [i, {}]));
      },
    });
    return { guild, borrados };
  }

  test('con la protección apagada no filtra nada', async () => {
    const { guild, borrados } = guildConBorrado('g-fil-off');
    store.setGuildConfig(guild.id, (c) => {
      c.proteccion = { activado: false, filtroInvites: true };
    });
    const member = miembroFake('u-1', guild);
    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m1', guild, member, { content: 'entren a discord.gg/trigger' })), false);
    assert.deepEqual(borrados, []);
  });

  test('borra las invitaciones cuando el filtro está prendido y deja pasar el resto', async () => {
    const { guild, borrados } = guildConBorrado('g-fil-inv');
    activar(guild.id, { filtroInvites: true });
    const member = miembroFake('u-2', guild);

    assert.equal(
      await proteccion.procesarMensajeParaFiltros(mensajeFake('m1', guild, member, { content: 'metanse en discord.gg/trigger-arena' })),
      true
    );
    assert.deepEqual(borrados, ['m1']);
    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m2', guild, member, { content: 'buenas tardes a todos' })), false);
    assert.deepEqual(borrados, ['m1'], 'un mensaje normal no se toca');
  });

  test('el filtro de enlaces respeta la lista permitida (y sus subdominios)', async () => {
    const { guild, borrados } = guildConBorrado('g-fil-links');
    activar(guild.id, { filtroLinks: true, linksPermitidos: ['nostalgia.ar'] });
    const member = miembroFake('u-3', guild);

    assert.equal(
      await proteccion.procesarMensajeParaFiltros(mensajeFake('m1', guild, member, { content: 'entren a https://cs.nostalgia.ar:27015' })),
      false
    );
    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m2', guild, member, { content: 'miren https://bit.ly/estafa' })), true);
    assert.deepEqual(borrados, ['m2']);
  });

  test('el filtro de menciones corta @everyone y las menciones por encima del máximo', async () => {
    const { guild, borrados } = guildConBorrado('g-fil-menc');
    activar(guild.id, { filtroMenciones: true, mencionesMaximas: 2 });
    const member = miembroFake('u-4', guild);
    const conMenciones = (id, usuarios) =>
      mensajeFake(id, guild, member, { content: 'miren esto', mentions: { everyone: false, users: { size: usuarios }, roles: { size: 0 } } });

    assert.equal(await proteccion.procesarMensajeParaFiltros(conMenciones('m1', 2)), false);
    assert.equal(await proteccion.procesarMensajeParaFiltros(conMenciones('m2', 3)), true);
    assert.equal(
      await proteccion.procesarMensajeParaFiltros(
        mensajeFake('m3', guild, member, { content: '@everyone entren', mentions: { everyone: true, users: { size: 0 }, roles: { size: 0 } } })
      ),
      true,
      '@everyone se corta aunque haya pocas menciones'
    );
    assert.deepEqual(borrados, ['m2', 'm3']);
  });

  test('el filtro de mayúsculas mide letras (no números ni emojis) y respeta el largo mínimo', async () => {
    const { guild, borrados } = guildConBorrado('g-fil-may');
    activar(guild.id, { filtroMayusculas: true, mayusculasPorcentaje: 70, mayusculasMinimo: 10 });
    const member = miembroFake('u-5', guild);

    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m1', guild, member, { content: 'ESTE MENSAJE 100% GRITA 🔥' })), true);
    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m2', guild, member, { content: 'GG WP' })), false, 'corto: no se evalúa');
    assert.equal(
      await proteccion.procesarMensajeParaFiltros(
        mensajeFake('m3', guild, member, { content: 'Buenas noches a toda la banda, entrando a jugar un rato' })
      ),
      false,
      'texto normal: no dispara'
    );
    assert.deepEqual(borrados, ['m1']);
  });

  test('el filtro de repetidos cuenta solo los iguales SEGUIDOS', async () => {
    const { guild, borrados } = guildConBorrado('g-fil-rep');
    activar(guild.id, { filtroRepetidos: true, repetidosVeces: 3 });
    const member = miembroFake('u-6', guild);

    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m1', guild, member, { content: 'hola' })), false);
    assert.equal(
      await proteccion.procesarMensajeParaFiltros(mensajeFake('m2', guild, member, { content: 'HOLA ' })),
      false,
      'normaliza mayúsculas y espacios'
    );
    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m3', guild, member, { content: 'hola' })), true);
    assert.deepEqual(borrados, ['m3']);

    const otro = miembroFake('u-7', guild);
    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m4', guild, otro, { content: 'hola' })), false);
    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m5', guild, otro, { content: 'chau' })), false);
    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m6', guild, otro, { content: 'hola' })), false, 'no son seguidos');
    assert.deepEqual(borrados, ['m3']);
  });

  test('avisa por DM una sola vez por usuario y filtro (cooldown), pero borra siempre', async () => {
    const { guild, borrados } = guildConBorrado('g-fil-dm');
    activar(guild.id, { filtroInvites: true });
    const member = miembroFake('u-8', guild);
    const dms = [];
    member.user.send = async (texto) => {
      dms.push(texto);
    };

    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m1', guild, member, { content: 'discord.gg/uno' })), true);
    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m2', guild, member, { content: 'discord.gg/dos' })), true);
    assert.deepEqual(borrados, ['m1', 'm2'], 'borra todos los mensajes filtrados');
    assert.equal(dms.length, 1, 'el aviso no se repite dentro del cooldown');
    assert.match(dms[0], /invitación a otro servidor/);
  });

  test('exime al staff del automod', async () => {
    const { guild, borrados } = guildConBorrado('g-fil-staff');
    activar(guild.id, { filtroInvites: true });
    const staff = miembroFake('staff-9', guild);
    staff.permissions.has = (p) => p === PermissionFlagsBits.ManageMessages;

    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m1', guild, staff, { content: 'discord.gg/nuestro' })), false);
    assert.deepEqual(borrados, []);
  });

  test('sin permiso de borrar, la alerta dice que NO se pudo borrar', async () => {
    const guild = guildFake('g-fil-sinperm'); // el bot NO tiene Gestionar mensajes
    const alertas = [];
    guild.channels.cache.set('canal-avisos', {
      id: 'canal-avisos',
      send: async ({ embeds }) => {
        alertas.push(...embeds);
      },
    });
    store.setGuildConfig(guild.id, (c) => {
      c.avisosChannel = 'canal-avisos';
      c.proteccion = { activado: true, filtroInvites: true };
    });
    const member = miembroFake('u-9', guild);

    assert.equal(await proteccion.procesarMensajeParaFiltros(mensajeFake('m1', guild, member, { content: 'discord.gg/uno' })), true);
    assert.equal(alertas.length, 1);
    const campos = alertas[0].data.fields.map((f) => `${f.name}: ${f.value}`).join(' | ');
    assert.match(campos, /no pude borrar el mensaje/, 'la alerta informa el resultado real');
  });
});

describe('normalizarDominios', () => {
  test('baja a minúsculas, saca www./*. , descarta lo inválido y no repite', () => {
    const limpios = proteccion.normalizarDominios(['WWW.Nostalgia.AR', '*.cs.nostalgia.ar', 'no-es-un-dominio', 'nostalgia.ar', '']);
    assert.deepEqual(limpios, ['nostalgia.ar', 'cs.nostalgia.ar']);
  });
});
