// /warnings — historial de advertencias de un usuario, con severidad visual.
// Severidad: 🟢 historial limpio · 🟡 con advertencias · 🔴 al límite (3 = silencio automático de 1 h).
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getWarns } = require('../warns');
const { brandEmbed } = require('../utils/replies');

const LIMITE_WARNS = 3; // mismo umbral que /warn (silencio automático de 1 h al tercer warn)

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Muestra el historial de advertencias de un usuario')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar').setRequired(true)),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const warns = getWarns(interaction.guild.id, user.id);

    // Historial limpio: verificación rápida, sin ficha grande.
    if (warns.length === 0) {
      const limpio = brandEmbed({
        color: 0x57f287,
        title: '📋 Historial limpio',
        description: `${user} no tiene advertencias registradas. ✨`,
        thumbnail: user.displayAvatarURL({ size: 128 }),
        footer: `TriggerBOT • ${LIMITE_WARNS} warns acumulados = silencio automático de 1 h`,
      });
      return interaction.reply({ embeds: [limpio], flags: MessageFlags.Ephemeral });
    }

    // Detalle de cada warn, del más nuevo al más viejo (número original = posición en el historial).
    const lista = warns
      .map((w, i) => {
        const fecha = `<t:${Math.floor(w.timestamp / 1000)}:f>`;
        return `**#${i + 1}** — ${fecha}\n> ${w.reason}\nPor: <@${w.moderatorId}>`;
      })
      .reverse()
      .join('\n\n');

    const restantes = Math.max(LIMITE_WARNS - warns.length, 0);
    const alLimite = warns.length >= LIMITE_WARNS;

    const embed = brandEmbed({
      color: alLimite ? 0xed4245 : 0xfee75c,
      title: `📋 Advertencias de ${user.tag}`,
      description: `**${warns.length}** advertencia(s) registrada(s) · **${restantes}** más y queda silenciado 1 h automáticamente`,
      thumbnail: user.displayAvatarURL({ size: 128 }),
      fields: [{ name: `Historial (${warns.length})`, value: lista.slice(0, 4000) }],
      footer: 'TriggerBOT • /quitarnota numero para eliminar una advertencia del historial',
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
