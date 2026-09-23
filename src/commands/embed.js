const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { brandEmbed, errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { quiereSilencioso, diferir, intentar } = require('../utils/acciones');

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
    .addChannelOption((o) => o.setName('canal').setDescription('Canal de destino (vacío = este canal)'))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async execute(interaction) {
    const titulo = interaction.options.getString('titulo', true);
    const texto = interaction.options.getString('texto', true);
    const colorHex = interaction.options.getString('color');
    const imagen = interaction.options.getString('imagen_url');
    const miniatura = interaction.options.getString('miniatura_url');
    const canal = interaction.options.getChannel('canal') ?? interaction.channel;
    const silencioso = quiereSilencioso(interaction);

    let color = COLORS.info;
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

    await diferir(interaction, silencioso);

    // El envío se reporta de verdad: antes se respondía "📢 Anuncio enviado"
    // incluso cuando Discord lo rechazaba (faltaba el permiso de escribir).
    const resultado = await intentar(`Discord rechazó el envío en <#${destino.id}>`, () => destino.send({ embeds: [embed] }));

    if (!resultado.ok) {
      return interaction.editReply({
        embeds: [
          errorEmbed(
            `No pude publicar el anuncio en <#${destino.id}>.
> ${resultado.error}`,
            'El anuncio no se publicó'
          ),
        ],
      });
    }

    return interaction.editReply({
      embeds: [
        accionEmbed({
          color: COLORS.success,
          titulo: '📢 Anuncio enviado',
          detalle: `Publicado en <#${destino.id}>.`,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          footer: 'se puede editar o borrar como cualquier mensaje',
        }),
      ],
    });
  },
};
