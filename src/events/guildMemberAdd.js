const { Events } = require('discord.js');
const { brandEmbed, COLORS } = require('../utils/replies');
const { registrarIngreso } = require('../utils/proteccion');

function renderWelcome(message, member) {
  return (message || '¡Bienvenido {usuario} a **{servidor}**! Sos el miembro #{miembros} 🎉')
    .replaceAll('{usuario}', `<@${member.id}>`)
    .replaceAll('{servidor}', member.guild.name)
    .replaceAll('{miembros}', String(member.guild.memberCount));
}

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    const { getGuildConfig } = require('../store');
    const config = getGuildConfig(member.guild.id);

    // Anti-raid: registra el ingreso y, si hay oleada, alerta/actúa según config.
    registrarIngreso(member).catch((error) => console.error('[TriggerBOT] Error en anti-raid:', error.message));

    // Autorol
    if (config.autorole) {
      const role = member.guild.roles.cache.get(config.autorole);
      if (role) {
        await member.roles.add(role).catch((error) =>
          console.error(`[TriggerBOT] No se pudo asignar el rol de bienvenida en ${member.guild.name}: ${error.message}`)
        );
      } else {
        console.warn(`[TriggerBOT] El rol configurado como autorol no existe en ${member.guild.name}. Reconfigurar con /config welcome.`);
      }
    }

    // Mensaje de bienvenida
    if (config.welcome?.channelId) {
      const channel = member.guild.channels.cache.get(config.welcome.channelId);
      if (channel) {
        const embed = brandEmbed({
          color: COLORS.success,
          title: `👋 ¡${member.user.tag} se unió!`,
          description: renderWelcome(config.welcome.message, member),
        });
        embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
        await channel.send({ embeds: [embed] }).catch((error) =>
          console.error(`[TriggerBOT] No se pudo enviar el mensaje de bienvenida en ${member.guild.name}: ${error.message}`)
        );
      } else {
        console.warn(`[TriggerBOT] El canal de bienvenida configurado no existe en ${member.guild.name}. Reconfigurar con /config welcome.`);
      }
    }
  },
};
