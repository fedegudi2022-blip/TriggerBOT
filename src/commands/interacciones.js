const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { ACCIONES, traerGIF, contar, total } = require('../utils/interacciones');
const { brandEmbed, errorEmbed } = require('../utils/replies');

// Frases de respaldo si la API de GIFs no responde.
function fraseRespaldo(accion, autor, receptor) {
  const textos = {
    beso: `${autor} le dio un beso a ${receptor}`,
    abrazo: `${autor} abrazó fuerte a ${receptor}`,
    caricia: `${autor} acarició la cabeza de ${receptor}`,
    abofetear: `${autor} le pegó una bofetada a ${receptor}`,
    morder: `${autor} mordió a ${receptor}`,
    pellizco: `${autor} pellizcó a ${receptor}`,
    chocar: `${autor} chocó los cinco con ${receptor}`,
    guino: `${autor} le guiñó el ojo a ${receptor}`,
  };
  return textos[accion];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('interaccion')
    .setDescription('Interacciones con GIFs para la comunidad')
    .addSubcommand((sc) => sc.setName('beso').setDescription('Dale un beso a alguien').addUserOption((o) => o.setName('usuario').setDescription('Receptor').setRequired(true)))
    .addSubcommand((sc) => sc.setName('abrazo').setDescription('Abraza a alguien').addUserOption((o) => o.setName('usuario').setDescription('Receptor').setRequired(true)))
    .addSubcommand((sc) => sc.setName('caricia').setDescription('Acaricia la cabeza de alguien').addUserOption((o) => o.setName('usuario').setDescription('Receptor').setRequired(true)))
    .addSubcommand((sc) => sc.setName('abofetear').setDescription('Abofetea a alguien').addUserOption((o) => o.setName('usuario').setDescription('Receptor').setRequired(true)))
    .addSubcommand((sc) => sc.setName('morder').setDescription('Muerde a alguien').addUserOption((o) => o.setName('usuario').setDescription('Receptor').setRequired(true)))
    .addSubcommand((sc) => sc.setName('pellizco').setDescription('Pellizca a alguien').addUserOption((o) => o.setName('usuario').setDescription('Receptor').setRequired(true)))
    .addSubcommand((sc) => sc.setName('chocar').setDescription('Choca los cinco con alguien').addUserOption((o) => o.setName('usuario').setDescription('Receptor').setRequired(true)))
    .addSubcommand((sc) => sc.setName('guino').setDescription('Guiña el ojo a alguien').addUserOption((o) => o.setName('usuario').setDescription('Receptor').setRequired(true))),

  async execute(interaction) {
    const accion = interaction.options.getSubcommand();
    const definicion = ACCIONES[accion];
    const receptor = interaction.options.getUser('usuario', true);

    if (receptor.id === interaction.user.id) {
      const textos = {
        beso: 'Te diste un beso en el espejo. Confianza ante todo.',
        abrazo: 'Te abrazaste a vos mismo. Lo intentamos.',
        caricia: 'Te acariciaste la cabeza. Está bien quererse.',
        abofetear: 'Te abofeteaste a vos mismo. ¿Todo bien?',
        morder: 'Te mordiste. Raro, pero ok.',
        pellizco: 'Te pellizcaste. ¿Sueño o realidad?',
        chocar: 'Chocaste los cinco con vos. ¡Buen trabajo, crack!',
        guino: 'Te guiñaste el ojo. Nivel máximo de confianza.',
      };
      return interaction.reply({ embeds: [brandEmbed({ color: 0xfee75c, title: definicion.emoji + ' Auto-interacción', description: textos[accion] })] });
    }

    if (receptor.bot) {
      return interaction.reply({ embeds: [errorEmbed('Los bots no participamos de estas cosas... bueno, quizá un abrazo no vendría mal.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    // GIF de la API gratuita; si falla, texto simple.
    const gif = await traerGIF(definicion.endpoint);

    // Contador: cuántas veces le hizo esta acción a este receptor.
    const veces = contar(interaction.guildId, accion, interaction.user.id, receptor.id);
    const recibidas = total(interaction.guildId, accion, receptor.id);

    const embed = new EmbedBuilder()
      .setColor(definicion.emoji === '💥' ? 0xed4245 : 0xe91e63)
      .setDescription(`**${interaction.member.displayName}** ${definicion.texto} **${receptor}** ${definicion.emoji}`)
      .setFooter({
        text: `Llevás ${veces} ${accion}${veces === 1 ? '' : 's'} a ${receptor.username} • recibió ${recibidas} en total`,
      });
    if (gif) embed.setImage(gif);

    await interaction.editReply({ embeds: [embed] }).catch(async () => {
      await interaction.editReply({ content: fraseRespaldo(accion, interaction.user, receptor) });
    });
  },
};

// Para validación de errores en el handler global (no usado directamente).
void brandEmbed;
