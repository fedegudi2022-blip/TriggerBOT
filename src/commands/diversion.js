const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { successEmbed, brandEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('diversion')
    .setDescription('Juegos rápidos para la comunidad')
    .addSubcommand((sc) => {
      const cmd = sc.setName('dado').setDescription('Tira un dado (1-6, o elegí cuántas caras)');
      return cmd.addIntegerOption((o) =>
        o.setName('caras').setDescription('Cantidad de caras (4-100, por defecto 6)').setMinValue(4).setMaxValue(100)
      );
    })
    .addSubcommand((sc) => sc.setName('moneda').setDescription('Tira una moneda: cara o ceca'))
    .addSubcommand((sc) =>
      sc
        .setName('beso')
        .setDescription('Dale un beso a otro usuario 😘')
        .addUserOption((o) => o.setName('usuario').setDescription('A quién le das un beso').setRequired(true))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'dado') {
      const caras = interaction.options.getInteger('caras') ?? 6;
      const resultado = Math.floor(Math.random() * caras) + 1;
      return interaction.reply({
        embeds: [successEmbed(`Sacaste un **${resultado}** con el dado de ${caras} caras.`, 'Dado 🎲')],
      });
    }

    if (sub === 'moneda') {
      const esCara = Math.random() < 0.5;
      return interaction.reply({
        embeds: [successEmbed(`Salió **${esCara ? 'CARA' : 'CECA'}**.`, 'Moneda 🪙')],
      });
    }

    if (sub === 'beso') {
      const objetivo = interaction.options.getUser('usuario', true);
      if (objetivo.id === interaction.user.id) {
        return interaction.reply({
          embeds: [brandEmbed({ color: 0xfee75c, title: '🪞 Auto-beso', description: 'Te diste un beso en el espejo... ¡confianza ante todo! 😄' })],
          flags: MessageFlags.Ephemeral,
        });
      }
      const besos = [
        `${interaction.user} le dió un beso a ${objetivo} 😘`,
        `${interaction.user} besó a ${objetivo} 💋`,
        `${objetivo} recibió un beso sorpresa de ${interaction.user} 😚`,
      ];
      return interaction.reply({ content: besos[Math.floor(Math.random() * besos.length)] });
    }
  },
};
