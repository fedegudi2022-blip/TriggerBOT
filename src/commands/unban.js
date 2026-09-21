const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');
const { avisarPorDM } = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Revoca el baneo de un usuario por su ID')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('usuario_id').setDescription('ID del usuario a desbanear (clic derecho → Copiar ID)').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del desbaneo').setMaxLength(500)),

  async execute(interaction) {
    const userId = interaction.options.getString('usuario_id', true).trim();
    const reason = interaction.options.getString('razon');

    if (!/^\d{17,20}$/.test(userId)) {
      return interaction.reply({
        embeds: [errorEmbed('Eso no parece una ID válida. Copiala con clic derecho sobre el usuario → **Copiar ID de usuario** (modo desarrollador activado).')],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const bans = await interaction.guild.bans.fetch().catch(() => null);
    if (!bans) {
      return interaction.editReply({ embeds: [errorEmbed('No pude leer la lista de baneos. Verificá que el bot tenga permiso de **Banear miembros**.')] });
    }

    const ban = bans.get(userId);
    if (!ban) {
      return interaction.editReply({ embeds: [errorEmbed('Ese usuario no está baneado en este servidor.')] });
    }

    await interaction.guild.members.unban(userId, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`);
    await avisarPorDM(ban.user, `✅ Fuiste desbaneado de **${interaction.guild.name}**. Podés volver a entrar.`);

    await interaction.editReply({
      embeds: [successEmbed(`**${ban.user.tag}** fue desbaneado. Ya puede volver a entrar al servidor.`)],
    });

    logAction(interaction.guild, {
      action: 'Desbaneo (unban)',
      color: 0x57f287,
      target: ban.user,
      moderator: interaction.user,
      reason,
    });
  },
};
