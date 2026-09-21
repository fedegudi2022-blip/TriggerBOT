const { SlashCommandBuilder } = require('discord.js');
const { successEmbed } = require('../utils/replies');

// Juegos rápidos como comandos directos: /dado y /moneda (antes eran subcomandos
// de /diversion; el /beso de acá se reemplazó por /beso con GIF y contadores).

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dado')
    .setDescription('Tira un dado (1-6, o elegí cuántas caras)')
    .addIntegerOption((o) =>
      o.setName('caras').setDescription('Cantidad de caras (4-100, por defecto 6)').setMinValue(4).setMaxValue(100)
    ),

  // /moneda se registra aparte (comando individual) usando la misma lógica.
  async execute(interaction) {
    const caras = interaction.options.getInteger('caras') ?? 6;
    const resultado = Math.floor(Math.random() * caras) + 1;
    return interaction.reply({
      embeds: [successEmbed(`Sacaste un **${resultado}** con el dado de ${caras} caras.`, 'Dado 🎲')],
    });
  },
};

// Comando /moneda generado con la misma mecánica (se exporta para index.js).
module.exports.moneda = {
  data: new SlashCommandBuilder().setName('moneda').setDescription('Tira una moneda: cara o ceca'),
  async execute(interaction) {
    const esCara = Math.random() < 0.5;
    return interaction.reply({
      embeds: [successEmbed(`Salió **${esCara ? 'CARA' : 'CECA'}**.`, 'Moneda 🪙')],
    });
  },
};
