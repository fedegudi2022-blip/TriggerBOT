const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { brandEmbed, errorEmbed } = require('../utils/replies');

const VOTACION_ABIERTA = new Map(); // messageId → { autorId, tema, titulo }

module.exports = {
  VOTACION_ABIERTA,

  data: new SlashCommandBuilder()
    .setName('encuesta')
    .setDescription('Crea una encuesta para que vote toda la comunidad')
    .addStringOption((o) => o.setName('tema').setDescription('Pregunta a votar').setRequired(true).setMaxLength(300))
    .addStringOption((o) =>
      o
        .setName('opciones')
        .setDescription('Opciones separadas por coma (2-6). Vacío = Sí/No')
        .setMaxLength(500)
    ),

  async execute(interaction) {
    const tema = interaction.options.getString('tema', true);
    const opcionesTexto = interaction.options.getString('opciones');

    const opciones = opcionesTexto
      ? opcionesTexto.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6)
      : ['Sí', 'No'];

    if (opciones.length < 2) {
      return interaction.reply({ embeds: [errorEmbed('Necesito al menos 2 opciones (separálas con coma).')], flags: MessageFlags.Ephemeral });
    }

    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
    const cuerpo = opciones.map((op, i) => `${emojis[i]} ${op}`).join('\n\n');

    const embed = brandEmbed({
      color: 0x5865f2,
      title: `${tema}`,
      description: cuerpo,
      footer: `Encuesta de ${interaction.user.tag} • votá con las reacciones`,
    });

    await interaction.reply({ embeds: [embed] });
    const mensaje = await interaction.fetchReply();
    VOTACION_ABIERTA.set(mensaje.id, { autorId: interaction.user.id, tema, titulo: `📊 ${tema}` });
    for (let i = 0; i < opciones.length; i++) mensaje.react(emojis[i]).catch(() => {});
  },
};
