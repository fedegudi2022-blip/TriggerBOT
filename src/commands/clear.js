const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { logAction } = require('../utils/modlog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Borra mensajes masivamente en este canal')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) =>
      o
        .setName('cantidad')
        .setDescription('Cantidad de mensajes a borrar (1-100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .addUserOption((o) => o.setName('usuario').setDescription('Borrar solo mensajes de este usuario'))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del borrado').setMaxLength(500)),

  async execute(interaction) {
    const amount = interaction.options.getInteger('cantidad', true);
    const user = interaction.options.getUser('usuario');
    const reason = interaction.options.getString('razon');

    await interaction.deferReply({ ephemeral: true });

    const fetched = await interaction.channel.bulkDelete(amount, true).catch((error) => {
      console.error('[clear]', error.message);
      return null;
    });

    if (!fetched) {
      return interaction.editReply('❌ No pude borrar mensajes. Discord no permite borrar mensajes de más de 14 días.');
    }

    let deleted = fetched.size;
    if (user) {
      const filtered = fetched.filter((m) => m.author.id === user.id).size;
      deleted = filtered;
    }

    const who = user ? ` de **${user.tag}**` : '';
    await interaction.editReply(`🧹 Borré **${deleted}** mensaje(s)${who}. (Este aviso se borra solo)`);

    // Auto-borra la confirmación a los 5 segundos
    setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);

    logAction(interaction.guild, {
      action: 'Borrado masivo (clear)',
      color: 0xfee75c,
      target: user ?? { id: interaction.channelId, tag: `#${interaction.channel.name}` },
      moderator: interaction.user,
      reason,
      extra: `Canal: <#${interaction.channelId}> — ${deleted} mensaje(s)`,
    });
  },
};
