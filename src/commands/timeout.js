const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { logAction } = require('../utils/modlog');

const DURATIONS = {
  '5m': 5 * 60 * 1000,
  '10m': 10 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '28d': 28 * 24 * 60 * 60 * 1000,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Silencia a un usuario por un tiempo determinado')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a silenciar').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('duracion')
        .setDescription('Cuánto tiempo queda silenciado')
        .setRequired(true)
        .addChoices(
          { name: '5 minutos', value: '5m' },
          { name: '10 minutos', value: '10m' },
          { name: '30 minutos', value: '30m' },
          { name: '1 hora', value: '1h' },
          { name: '6 horas', value: '6h' },
          { name: '1 día', value: '1d' },
          { name: '3 días', value: '3d' },
          { name: '7 días', value: '7d' },
          { name: '28 días (máximo de Discord)', value: '28d' }
        )
    )
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del silencio').setMaxLength(500)),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const durationKey = interaction.options.getString('duracion', true);
    const reason = interaction.options.getString('razon');
    const ms = DURATIONS[durationKey];

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      return interaction.reply({ content: '❌ Ese usuario no está en el servidor.', ephemeral: true });
    }
    if (member.id === interaction.user.id) {
      return interaction.reply({ content: '❌ No te podés silenciar a vos mismo.', ephemeral: true });
    }
    if (!member.moderatable) {
      return interaction.reply({ content: '❌ No puedo silenciarlo: su rol está por encima del mío (o es el dueño).', ephemeral: true });
    }

    await member.timeout(ms, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`);

    await interaction.reply(`🔇 **${user.tag}** quedó silenciado por **${durationKey}**. Razón: ${reason || '*sin especificar*'}`);
    logAction(interaction.guild, {
      action: 'Silencio (timeout)',
      target: user,
      moderator: interaction.user,
      reason,
      duration: durationKey,
    });
  },
};
