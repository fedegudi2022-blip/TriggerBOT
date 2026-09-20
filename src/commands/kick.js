const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { logAction } = require('../utils/modlog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulsa a un usuario del servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a expulsar').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo de la expulsión').setMaxLength(500)),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    if (!member) {
      return interaction.reply({ content: '❌ Ese usuario no está en el servidor.', ephemeral: true });
    }
    if (member.id === interaction.user.id) {
      return interaction.reply({ content: '❌ No te podés expulsar a vos mismo.', ephemeral: true });
    }
    if (!member.kickable) {
      return interaction.reply({ content: '❌ No puedo expulsarlo: su rol está por encima del mío (o es el dueño).', ephemeral: true });
    }

    await user
      .send(`⚠️ Fuiste expulsado de **${interaction.guild.name}**. Razón: ${reason || '*sin especificar*'}`)
      .catch(() => {}); // puede tener DMs cerrados

    await member.kick(reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`);

    await interaction.reply(`👢 **${user.tag}** fue expulsado. Razón: ${reason || '*sin especificar*'}`);
    logAction(interaction.guild, {
      action: 'Expulsión (kick)',
      target: user,
      moderator: interaction.user,
      reason,
    });
  },
};
