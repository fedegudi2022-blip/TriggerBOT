// Tests de src/utils/moderation.js — jerarquía moderador→objetivo y validación del bot.
// Son funciones puras: no tocan disco ni red, solo objetos de Discord simulados.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { motivoNoModerable, validarAccionDelBot } = require('../src/utils/moderation');

// ---------- Fábricas de objetos falsos ----------
function miembroFake(id, posicionRol, { permisos = [], bot = false } = {}) {
  return {
    id,
    user: { id, bot, tag: `usuario-${id}` },
    roles: { highest: { position: posicionRol }, cache: { size: 2 } },
    permissions: { has: (p) => permisos.includes(p) },
  };
}

function interactionFake({ userId, botId = 'bot-1', ownerId, posicionModerador = 5, permisosModerador = [] }) {
  return {
    user: { id: userId },
    client: { user: { id: botId } },
    guild: { ownerId },
    member: miembroFake(userId, posicionModerador, { permisos: permisosModerador }),
  };
}

function guildFake({ botPosicion = 10, botPermisos = [], ownerId = 'owner-1' }) {
  return {
    id: 'g-1',
    ownerId,
    members: { me: miembroFake('bot-1', botPosicion, { bot: true, permisos: botPermisos }) },
    client: { user: { id: 'bot-1' } },
  };
}

// ---------- motivoNoModerable: jerarquía del moderador ----------
describe('motivoNoModerable', () => {
  test('permite moderar a un usuario con rol inferior', () => {
    const interaction = interactionFake({ userId: 'mod-1', ownerId: 'owner-1' });
    const objetivo = miembroFake('obj-1', 1);
    assert.equal(motivoNoModerable(interaction, objetivo), null);
  });

  test('rechaza si el objetivo no está en el servidor', () => {
    const interaction = interactionFake({ userId: 'mod-1', ownerId: 'owner-1' });
    assert.ok(motivoNoModerable(interaction, null));
  });

  test('rechaza moderarse a sí mismo', () => {
    const interaction = interactionFake({ userId: 'mod-1', ownerId: 'owner-1' });
    const objetivo = miembroFake('mod-1', 1);
    assert.match(motivoNoModerable(interaction, objetivo), /mismo/);
  });

  test('rechaza moderar al bot', () => {
    const interaction = interactionFake({ userId: 'mod-1', ownerId: 'owner-1' });
    const objetivo = miembroFake('bot-1', 1, { bot: true });
    assert.match(motivoNoModerable(interaction, objetivo), /mí mismo/);
  });

  test('rechaza moderar a alguien con rol igual o superior (moderador normal)', () => {
    const interaction = interactionFake({ userId: 'mod-1', ownerId: 'owner-1', posicionModerador: 5 });
    const objetivo = miembroFake('obj-1', 5); // mismo nivel
    assert.match(motivoNoModerable(interaction, objetivo), /mismo rol o uno superior/);

    const objetivoAlto = miembroFake('obj-2', 9);
    assert.match(motivoNoModerable(interaction, objetivoAlto), /mismo rol o uno superior/);
  });

  test('el dueño del servidor puede moderar roles iguales o superiores', () => {
    const interaction = interactionFake({ userId: 'owner-1', ownerId: 'owner-1', posicionModerador: 1 });
    const objetivo = miembroFake('obj-1', 9);
    assert.equal(motivoNoModerable(interaction, objetivo), null);
  });
});

// ---------- validarAccionDelBot: lo que EL BOT puede hacer ----------
describe('validarAccionDelBot', () => {
  const KICK = PermissionFlagsBits.KickMembers;

  test('rechaza si el objetivo no está en el servidor', () => {
    const guild = guildFake({ botPermisos: [KICK] });
    assert.match(validarAccionDelBot(guild, null, KICK), /no está en el servidor/);
  });

  test('rechaza actuando sobre sí mismo', () => {
    const guild = guildFake({ botPermisos: [KICK] });
    const bot = guild.members.me;
    assert.match(validarAccionDelBot(guild, bot, KICK), /mí mismo/);
  });

  test('rechaza moderar al dueño del servidor', () => {
    const guild = guildFake({ botPermisos: [KICK] });
    const dueno = miembroFake('owner-1', 1);
    assert.match(validarAccionDelBot(guild, dueno, KICK), /dueño/);
  });

  test('rechaza si al bot le falta el permiso concreto', () => {
    const guild = guildFake({ botPermisos: [] }); // sin permisos
    const objetivo = miembroFake('obj-1', 1);
    assert.match(validarAccionDelBot(guild, objetivo, KICK), /Me falta el permiso/);
  });

  test('rechaza si el rol del objetivo está por encima o al mismo nivel del bot', () => {
    const guild = guildFake({ botPosicion: 10, botPermisos: [KICK] });
    const objetivo = miembroFake('obj-1', 10); // igual que el bot
    assert.match(validarAccionDelBot(guild, objetivo, KICK), /por debajo o al mismo nivel/);

    const objetivoAlto = miembroFake('obj-2', 11);
    assert.match(validarAccionDelBot(guild, objetivoAlto, KICK), /por debajo o al mismo nivel/);
  });

  test('permite la acción si hay permiso y jerarquía a favor', () => {
    const guild = guildFake({ botPosicion: 10, botPermisos: [KICK] });
    const objetivo = miembroFake('obj-1', 1);
    assert.equal(validarAccionDelBot(guild, objetivo, KICK), null);
  });

  test('no se puede compensar jerarquía con permisos: admin sin rol alto sigue bloqueado', () => {
    // Caso real que motivó el cambio: un admin con rol bajo y todos los permisos.
    const guild = guildFake({ botPosicion: 5, botPermisos: [KICK, PermissionFlagsBits.BanMembers] });
    const objetivo = miembroFake('obj-1', 8);
    assert.match(validarAccionDelBot(guild, objetivo, PermissionFlagsBits.BanMembers), /mismo nivel/);
  });
});
