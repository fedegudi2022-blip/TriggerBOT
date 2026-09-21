const { SlashCommandBuilder } = require('discord.js');
const { brandEmbed } = require('../utils/replies');

const RESPUESTAS = [
  'Sí, definitivamente.',
  'Es seguro.',
  'Sin dudas.',
  'Obvio que sí.',
  'Contá con eso.',
  'Pinta bien.',
  'Se ve prometedor.',
  'Probablemente sí.',
  'Las señales apuntan que sí.',
  'Preguntame de nuevo más tarde.',
  'Mejor no te digo ahora.',
  'Concéntrate y volvé a preguntar.',
  'Ni idea, la verdad.',
  'No cuentes con eso.',
  'Mi respuesta es no.',
  'Mis fuentes dicen que no.',
  'Se ve mal.',
  'Muy dudoso.',
  'Definitivamente no.',
  'En tus sueños.',
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('La bola 8 mágica responde tu pregunta')
    .addStringOption((o) => o.setName('pregunta').setDescription('Tu pregunta para la bola').setRequired(true).setMaxLength(200)),

  async execute(interaction) {
    const pregunta = interaction.options.getString('pregunta', true);
    const respuesta = RESPUESTAS[Math.floor(Math.random() * RESPUESTAS.length)];

    const embed = brandEmbed({
      color: 0x2c2f33,
      title: 'Bola 8',
      description: `**Pregunta:** ${pregunta}\n\n🎱 **${respuesta}**`,
      footer: `Preguntado por ${interaction.user.username}`,
    });

    return interaction.reply({ embeds: [embed] });
  },
};
