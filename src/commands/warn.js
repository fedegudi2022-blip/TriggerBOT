const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getWarns, addWarn } = require('../warns');
const { logAction } = require('../utils/modlog');
const { logEvent } = require('../utils/log');
const { successEmbed, errorEmbed } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');

const LIMITE_WARNS = 3;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Advierte a un usuario (a los 3 warns queda silenciado 1 hora automáticamente)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a advertir').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo de la advertencia').setMaxLength(500)),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const error = motivoNoModerable(interaction, member);
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], ephemeral: true });
    }

    const total = addWarn(interaction.guild.id, user.id, {
      reason: reason || 'Sin especificar',
      moderatorId: interaction.user.id,
      timestamp: Date.now(),
    });

    const restantes = Math.max(LIMITE_WARNS - total, 0);
    await avisarPorDM(
      user,
      `⚠️ Recibiste una advertencia en **${interaction.guild.name}**.\n` +
        `**Motivo:** ${reason || '*sin especificar*'}\n` +
        `**Advertencias acumuladas:** ${total} de ${LIMITE_WARNS}`
    );

    await interaction.reply({
      embeds: [
        successEmbed(
          `${user} fue advertido por ${interaction.user}.\n` +
            `**Motivo:** ${reason || '*sin especificar*'}\n` +
            `**Historial:** ${total} advertencia(s)${restantes > 0 ? ` — le ${restantes === 1 ? 'queda' : 'quedan'} ${restantes} antes del silencio automático` : ''}`
        ),
      ],
    });

    // Escalada automática: al tercer warn, timeout de 1 hora.
    if (total >= LIMITE_WARNS && member?.moderatable) {
      await member.timeout(60 * 60 * 1000, `Acumuló ${total} advertencias — por ${interaction.user.tag}`).catch(() => {});
      await interaction.followUp({
        embeds: [successEmbed(`${user} acumuló **${total} advertencias** y quedó silenciado 1 hora automáticamente.`)],
      });
      logAction(interaction.guild, {
        action: 'Silencio automático (3 warns)',
        target: user,
        moderator: interaction.client.user,
        reason: `Acumuló ${total} advertencias`,
        duration: '1h',
      });
    }

    logAction(interaction.guild, {
      action: 'Advertencia (warn)',
      color: 0xfee75c,
      target: user,
      moderator: interaction.user,
      reason,
      extra: `Total acumulado: ${total} advertencia(s).`,
    });
    logEvent(interaction.guild, {
      color: 0xfee75c,
      title: '⚠️ Advertencia',
      description: `${user} fue advertido por ${interaction.user}.`,
      fields: [
        { name: 'Motivo', value: reason || '*Sin especificar*' },
        { name: 'Acumulado', value: `${total} advertencia(s)`, inline: true },
      ],
    });
  },
};
