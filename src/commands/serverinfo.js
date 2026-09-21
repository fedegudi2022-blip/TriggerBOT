const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { brandEmbed } = require('../utils/replies');

const NIVELES = {
  NONE: 'Ninguno',
  LOW: 'Bajo (teléfono verificado)',
  MEDIUM: 'Medio (miembro +5 min)',
  HIGH: 'Alto (+10 min en el server)',
  VERY_HIGH: 'Muy alto (teléfono requerido)',
};

// premiumTier puede llegar como número (discord.js nuevo) o como string "TIER_X".
const NIVELES_BOOST = { 0: 'sin boosts', 1: 'nivel 1', 2: 'nivel 2', 3: 'nivel 3' };
function textoBoosts(tier) {
  return NIVELES_BOOST[tier] ?? String(tier).replace('TIER_', 'nivel ') ?? 'sin boosts';
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

    const embed = brandEmbed({
      color: 0x5865f2,
      title: g.name,
      thumbnail: g.iconURL({ size: 256 }),
      fields: [
        { name: 'Dueño', value: `<@${g.ownerId}>`, inline: true },
        { name: 'Miembros', value: String(g.memberCount), inline: true },
        { name: 'Creado', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Canales de texto', value: String(texto), inline: true },
        { name: 'Canales de voz', value: String(voz), inline: true },
        { name: 'Categorías', value: String(categorias), inline: true },
        { name: 'Roles', value: String(g.roles.cache.size), inline: true },
        { name: 'Boosts', value: `${g.premiumSubscriptionCount ?? 0} (${textoBoosts(g.premiumTier)})`, inline: true },
        { name: 'Verificación', value: NIVELES[g.verificationLevel] ?? g.verificationLevel, inline: true },
        { name: 'Emojis', value: String(g.emojis.cache.size), inline: true },
      ],
      footer: `TriggerBOT • ID: ${g.id}`,
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
