const { Events } = require('discord.js');
const { logEvent } = require('../utils/log');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    if (member.user.bot) return;

    logEvent(member.guild, {
      color: 0x99aab5,
      title: '👋 Miembro salió',
      description: `**${member.user.tag}** dejó el servidor.`,
      thumbnail: member.user.displayAvatarURL({ size: 128 }),
      fields: [
        { name: 'Miembro #', value: String(member.guild.memberCount), inline: true },
        {
          name: 'Se unió',
          value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : '*desconocido*',
          inline: true,
        },
      ],
    });
  },
};
