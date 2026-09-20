const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { logAction } = require('../utils/modlog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Banea a un usuario del servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a banear').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del baneo').setMaxLength(500))
    .addIntegerOption((o) =>
      o
        .setName('borrar_dias')
        .setDescription('Borrar mensajes de los últimos X días (0-7)')
        .setMinValue(0)
        .setMaxValue(7)
    ),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const deleteDays = interaction.options.getInteger('borrar_dias') ?? 0;

    if (user.id === interaction.user.id) {
      return interaction.reply({ content: '❌ No te podés banear a vos mismo.', ephemeral: true });
    }
    if (user.id === interaction.client.user.id) {
      return interaction.reply({ content: '❌ No pienso auto-banearme 😤', ephemeral: true });
    }

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (member && !member.bannable) {
      return interaction.reply({ content: '❌ No puedo banearlo: su rol está por encima del mío (o es el dueño).', ephemeral: true });
    }

    await user
      .send(`⛔ Fuiste baneado de **${interaction.guild.name}**. Razón: ${reason || '*sin especificar*'}`)
      .catch(() => {});

    await interaction.guild.members.ban(user.id, {
      deleteMessageSeconds: deleteDays * 86400,
      reason: reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`,
    });

    await interaction.reply(`🔨 **${user.tag}** fue baneado.${deleteDays > 0 ? ` (mensajes de ${deleteDays} día(s) borrados)` : ''}`);
    logAction(interaction.guild, {
      action: 'Baneo (ban)',
      target: user,
      moderator: interaction.user,
      reason,
      extra: deleteDays > 0 ? `Se borraron sus mensajes de los últimos ${deleteDays} día(s).` : undefined,
    });
  },
};
