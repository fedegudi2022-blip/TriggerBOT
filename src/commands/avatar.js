const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { brandEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Muestra el avatar de un usuario en grande')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar (vacío = vos)')),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario') ?? interaction.user;

    const embed = brandEmbed({
      color: 0x5865f2,
      title: `🖼️ Avatar de ${user.tag}`,
      image: { url: user.displayAvatarURL({ size: 1024, extension: 'png' }) },
      description: `[Descargar en 1024px](${user.displayAvatarURL({ size: 1024, extension: 'png' })})`,
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
