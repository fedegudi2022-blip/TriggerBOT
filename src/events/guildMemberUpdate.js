const { Events } = require('discord.js');
const { logEvent } = require('../utils/log');

// Diferencia dos conjuntos de IDs y devuelve { agregados, quitados } como menciones.
function diffRoles(antes, despues) {
  const agregados = [...despues].filter((r) => !antes.includes(r));
  const quitados = [...antes].filter((r) => !despues.includes(r));
  return {
    agregados: agregados.map((id) => `<@&${id}>`),
    quitados: quitados.map((id) => `<@&${id}>`),
  };
}

module.exports = {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    // Cambio de apodo
    if (oldMember.nickname !== newMember.nickname) {
      logEvent(newMember.guild, {
        color: 0x5865f2,
        title: '🏷️ Apodo actualizado',
        description: `${newMember.user} (\`${newMember.user.tag}\`)`,
        fields: [
          { name: 'Antes', value: oldMember.nickname ? `\`${oldMember.nickname}\`` : '*sin apodo*', inline: true },
          { name: 'Después', value: newMember.nickname ? `\`${newMember.nickname}\`` : '*sin apodo*', inline: true },
        ],
      });
    }

    // Altas y bajas de roles
    const { agregados, quitados } = diffRoles([...oldMember.roles.cache.keys()], [...newMember.roles.cache.keys()]);
    if (agregados.length === 0 && quitados.length === 0) return;

    const fields = [];
    if (agregados.length) fields.push({ name: '➕ Roles añadidos', value: agregados.join(', ').slice(0, 1024) });
    if (quitados.length) fields.push({ name: '➖ Roles quitados', value: quitados.join(', ').slice(0, 1024) });

    logEvent(newMember.guild, {
      color: agregados.length ? 0x57f287 : 0xe67e22,
      title: '🎭 Roles actualizados',
      description: `${newMember.user} (\`${newMember.user.tag}\`)`,
      fields,
    });
  },
};
