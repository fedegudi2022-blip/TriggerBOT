const { Events } = require('discord.js');
const { logEvent, tiempoRelativo } = require('../utils/log');
const { COLORS } = require('../utils/replies');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    if (member.user.bot) return;

    const fields = [
      { name: 'Usuario', value: `${member.user} (\`${member.user.tag}\`)`, inline: true },
      { name: 'ID', value: `\`${member.id}\``, inline: true },
      { name: 'Miembros totales', value: String(member.guild.memberCount), inline: true },
    ];

    if (member.joinedTimestamp) {
      fields.push({
        name: 'Estuvo en el server',
        value: tiempoRelativo(Date.now() - member.joinedTimestamp),
        inline: true,
      });
    }

    logEvent(member.guild, {
      color: COLORS.gris,
      title: 'Miembro salió',
      thumbnail: member.user.displayAvatarURL({ size: 128 }),
      fields,
    });
  },
};
