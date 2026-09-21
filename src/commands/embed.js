const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { brandEmbed, errorEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Crea un mensaje embed profesional (solo staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('titulo').setDescription('Título del anuncio').setRequired(true).setMaxLength(256))
    .addStringOption((o) => o.setName('texto').setDescription('Cuerpo del mensaje').setRequired(true).setMaxLength(4000))
    .addStringOption((o) => o.setName('color').setDescription('Color en hex sin # (ej: 5865f2)').setMaxLength(6))
    .addStringOption((o) => o.setName('imagen_url').setDescription('URL de imagen para el anuncio'))
    .addStringOption((o) => o.setName('miniatura_url').setDescription('URL de miniatura (esquina)'))
    .addChannelOption((o) => o.setName('canal').setDescription('Canal de destino (vacío = este canal)')),

  async execute(interaction) {
    const titulo = interaction.options.getString('titulo', true);
    const texto = interaction.options.getString('texto', true);
    const colorHex = interaction.options.getString('color');
    const imagen = interaction.options.getString('imagen_url');
    const miniatura = interaction.options.getString('miniatura_url');
    const canal = interaction.options.getChannel('canal') ?? interaction.channel;

    let color = 0x5865f2;
    if (colorHex) {
      if (!/^[0-9a-fA-F]{6}$/.test(colorHex)) {
        return interaction.reply({
          embeds: [errorEmbed('El color debe ser hexadecimal sin #, por ejemplo `5865f2` o `ff0000`.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      color = parseInt(colorHex, 16);
    }

    const embed = brandEmbed({
      color,
      title: titulo,
      description: texto,
      image: imagen ? { url: imagen } : undefined,
      thumbnail: miniatura ? miniatura : undefined,
      footer: `Anuncio de ${interaction.user.tag}`,
    });

    const destino = interaction.guild.channels.cache.get(canal.id) ?? canal;
    await destino.send({ embeds: [embed] }).catch(() => {});

    return interaction.reply({
      embeds: [brandEmbed({ color: 0x57f287, title: '📢 Anuncio enviado', description: `Publicado en ${destino}.` })],
      flags: MessageFlags.Ephemeral,
    });
  },
};
