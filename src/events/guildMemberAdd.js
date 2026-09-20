const { Events, EmbedBuilder } = require('discord.js');

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

    // Autorol
    if (config.autorole) {
      const role = member.guild.roles.cache.get(config.autorole);
      if (role) {
        await member.roles.add(role).catch((error) =>
          console.error(`[autorol] No pude dar el rol en ${member.guild.name}:`, error.message)
        );
      } else {
        console.warn(`[autorol] El rol ${config.autorole} no existe en ${member.guild.name}. Reconfigurá con /config welcome.`);
      }
    }

    // Mensaje de bienvenida
    if (config.welcome?.channelId) {
      const channel = member.guild.channels.cache.get(config.welcome.channelId);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setAuthor({ name: `¡${member.user.tag} se unió!`, iconURL: member.user.displayAvatarURL() })
          .setDescription(renderWelcome(config.welcome.message, member))
          .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
          .setTimestamp();
        await channel.send({ embeds: [embed] }).catch((error) =>
          console.error(`[welcome] No pude enviar el mensaje en ${member.guild.name}:`, error.message)
        );
      } else {
        console.warn(`[welcome] El canal ${config.welcome.channelId} no existe en ${member.guild.name}. Reconfigurá con /config welcome.`);
      }
    }
  },
};
