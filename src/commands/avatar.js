const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { brandEmbed } = require('../utils/replies');

// Formatos que ofrece Discord y para qué sirve cada uno.
const FORMATOS = [
  { clave: 'png', etiqueta: 'PNG', emoji: '🖼️' },
  { clave: 'jpg', etiqueta: 'JPG', emoji: '📸' },
  { clave: 'webp', etiqueta: 'WEBP', emoji: '🕸️' },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Muestra el avatar de un usuario en grande, con links de descarga')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar (vacío = vos)')),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario') ?? interaction.user;

    // Fetch con force para tener el color de acento del perfil fresco.
    const completo = await interaction.client.users.fetch(user.id, { force: true }).catch(() => null);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    // Prioridad de color: rol más alto del miembro > acento del perfil > azul del bot.
    const color = member?.displayColor || completo?.accentColor || 0x5865f2;

    // Avatar específico del servidor (si el usuario tiene uno distinto al global).
    const avatarServidor = member?.avatar;
    const urlServidor = avatarServidor ? member.displayAvatarURL({ size: 1024, extension: 'png' }) : null;
    const urlGlobal = user.displayAvatarURL({ size: 1024, extension: 'png' });
    const esGif = user.avatar?.startsWith('a_');

    const embed = brandEmbed({
      color,
      title: `Avatar de ${user.tag}`,
      description:
        `[Descargar PNG · 1024px](${urlGlobal})` +
        (esGif ? ' · **¡tiene avatar animado!** probá el botón WEBP' : '') +
        (urlServidor ? '\nEste avatar es **específico del servidor** — usa los botones de abajo para ver ambos.' : ''),
      image: { url: urlGlobal },
      footer: `TriggerBOT • ID: ${user.id}`,
    });

    // Botones: un link directo por formato + avatares del servidor si corresponde.
    const botones = new ActionRowBuilder();
    for (const f of FORMATOS) {
      botones.addComponents(
        new ButtonBuilder()
          .setLabel(f.etiqueta)
          .setEmoji(f.emoji)
          .setStyle(ButtonStyle.Link)
          .setURL(user.displayAvatarURL({ size: 1024, extension: f.clave }))
      );
    }

    const filas = [botones];
    if (urlServidor) {
      const filaServidor = new ActionRowBuilder();
      filaServidor.addComponents(
        new ButtonBuilder().setLabel('Ver avatar del server').setEmoji('🏠').setStyle(ButtonStyle.Link).setURL(urlServidor),
        new ButtonBuilder().setLabel('Ver avatar global').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(urlGlobal)
      );
      filas.push(filaServidor);
    }

    return interaction.reply({ embeds: [embed], components: filas, flags: MessageFlags.Ephemeral });
  },
};
