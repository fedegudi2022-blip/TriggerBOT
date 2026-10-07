const { Events } = require('discord.js');
const { logEvent, tiempoRelativo } = require('../utils/log');
const { nombreDe, COLORS } = require('../utils/replies');
const censo = require('../utils/censo');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    // Fuera del censo: si no, el conteo de «en línea» seguiría incluyendo a quien ya se fue
    // hasta la próxima foto completa (hasta 6 h después).
    censo.olvidarMiembro(member.guild?.id, member.id);

    if (member.user.bot) return;

    const fields = [
      { name: 'Usuario', value: `${member.user} (\`${nombreDe(member.user)}\`)`, inline: true },
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
