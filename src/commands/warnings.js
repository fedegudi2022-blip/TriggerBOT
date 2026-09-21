const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getWarns } = require('../warns');
const { brandEmbed, warnEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Muestra el historial de advertencias de un usuario')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar').setRequired(true)),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const warns = getWarns(interaction.guild.id, user.id);

    if (warns.length === 0) {
      return interaction.reply({ embeds: [warnEmbed(`${user} no tiene advertencias registradas. ✨`, '📋 Historial limpio')], flags: MessageFlags.Ephemeral });
    }

    const lista = warns
      .map((w, i) => {
        const fecha = `<t:${Math.floor(w.timestamp / 1000)}:f>`;
        return `**#${i + 1}** — ${fecha}\nMotivo: ${w.reason}\nPor: <@${w.moderatorId}>`;
      })
      .join('\n\n');

    const embed = brandEmbed({
      color: 0xfee75c,
      title: `📋 Advertencias de ${user.tag} (${warns.length})`,
      description: lista.slice(0, 4000) || '—',
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
