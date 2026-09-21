const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { brandEmbed } = require('../utils/replies');

// Estos valores pueden llegar como número o como string según la versión de la API,
// así que normalizamos con mapas numéricos.
const NIVELES_VERIFICACION = { 0: 'Ninguno', 1: 'Bajo', 2: 'Medio', 3: 'Alto', 4: 'Muy alto' };
function nivelVerificacion(v) {
  return NIVELES_VERIFICACION[Number(v)] ?? 'Desconocido';
}

function textoBoosts(tier) {
  const n = Number(tier) || 0;
  return n === 0 ? 'sin boosts' : `nivel ${n}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Muestra la ficha completa del servidor'),

  async execute(interaction) {
    const g = interaction.guild;

    const canales = g.channels.cache;
    const texto = canales.filter((c) => c.type === 0).size;
    const voz = canales.filter((c) => c.type === 2).size;
    const categorias = canales.filter((c) => c.type === 4).size;
    const creado = Math.floor(g.createdTimestamp / 1000);

    const embed = brandEmbed({
      color: 0x9b59b6,
      title: g.name,
      description: g.description ? `*${g.description}*` : undefined,
      thumbnail: g.iconURL({ size: 256 }),
      fields: [
        { name: 'Dueño', value: `<@${g.ownerId}>`, inline: true },
        { name: 'Miembros', value: `**${g.memberCount}**`, inline: true },
        { name: 'Creado', value: `<t:${creado}:D>\n(<t:${creado}:R>)`, inline: true },
        { name: 'Canales', value: `Texto: **${texto}**\nVoz: **${voz}**\nCategorías: **${categorias}**`, inline: true },
        { name: 'Roles', value: `**${g.roles.cache.size}**`, inline: true },
        { name: 'Emojis', value: `**${g.emojis.cache.size}**`, inline: true },
        { name: 'Boosts', value: `**${g.premiumSubscriptionCount ?? 0}** (${textoBoosts(g.premiumTier)})`, inline: true },
        { name: 'Verificación', value: nivelVerificacion(g.verificationLevel), inline: true },
        { name: '2FA del staff', value: g.mfaLevel === 2 || g.mfaLevel === 1 ? 'Requerida' : 'No requerida', inline: true },
      ],
      footer: `TriggerBOT • ID del servidor: ${g.id}`,
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
