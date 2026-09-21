const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { brandEmbed, miles, barra } = require('../utils/replies');

// Estos valores pueden llegar como número o como string según la versión de la API,
// así que normalizamos con mapas numéricos.
const NIVELES_VERIFICACION = { 0: 'Ninguno', 1: 'Bajo', 2: 'Medio', 3: 'Alto', 4: 'Muy alto' };
function nivelVerificacion(v) {
  return NIVELES_VERIFICACION[Number(v)] ?? 'Desconocido';
}

const NOMBRES_TIER = ['Sin nivel', 'Nivel 1', 'Nivel 2', 'Nivel 3'];

// Boosts necesarios para cada tier (según la documentación de Discord).
const BOOSTS_POR_TIER = { 1: 2, 2: 7, 3: 14 };

// Cuántos boosts faltan para el próximo nivel de boost, con barra de progreso.
function progresoBoosts(actual, tier) {
  const t = Number(tier) || 0;
  if (t >= 3) return `**${miles(actual)}** boosts — nivel máximo alcanzado 🎉`;
  const proximo = t + 1;
  const necesario = BOOSTS_POR_TIER[proximo];
  const faltan = Math.max(necesario - actual, 0);
  return `**${miles(actual)}/${necesario}** para ${NOMBRES_TIER[proximo]}\n\`${barra(actual, necesario, 8)}\` faltan **${faltan}**`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Muestra la ficha completa del servidor'),

  async execute(interaction) {
    const g = interaction.guild;

    // Para el conteo de humanos vs bots: usa la caché si ya está completa (server
    // chico o recién scaneada) y solo descarga si falta gente. Un server chico
    // responde al instante; uno grande descarga una vez y después sirve de caché.
    const falta = Number.isFinite(g.memberCount) ? g.memberCount - g.members.cache.size : 1;
    if (falta > 0) await g.members.fetch().catch(() => {});

    const canales = g.channels.cache;
    const texto = canales.filter((c) => c.type === 0).size;
    const voz = canales.filter((c) => c.type === 2).size;
    const categorias = canales.filter((c) => c.type === 4).size;
    const foros = canales.filter((c) => c.type === 15).size;
    const creado = Math.floor(g.createdTimestamp / 1000);
    const dias = Math.floor((Date.now() - g.createdTimestamp) / 86400000);
    const anios = Math.floor(dias / 365);
    const antiguedad = anios > 0 ? `${anios} año(s) y ${Math.floor((dias % 365) / 30)} mes(es)` : `${Math.floor(dias / 30)} mes(es)`;

    const miembros = g.members.cache;
    const bots = miembros.filter((m) => m.user.bot).size;
    const humanos = Math.max(g.memberCount - bots, 0);

    const embed = brandEmbed({
      color: 0x9b59b6,
      title: g.name,
      description: g.description ? `*${g.description}*\n` : '',
      thumbnail: g.iconURL({ size: 256 }),
      fields: [
        { name: '👑 Dueño', value: `<@${g.ownerId}>`, inline: true },
        { name: '👥 Miembros', value: `**${miles(g.memberCount)}**\n${miles(humanos)} humanos · ${miles(bots)} bots`, inline: true },
        { name: '🎂 Creado', value: `<t:${creado}:D>\n<t:${creado}:R> · hace ${antiguedad}`, inline: true },
        {
          name: '💬 Canales',
          value:
            `Texto: **${texto}** · Voz: **${voz}**\n` +
            `Categorías: **${categorias}**${foros ? ` · Foros: **${foros}**` : ''}\n` +
            `Total: **${canales.size}**`,
          inline: true,
        },
        { name: '🎭 Roles', value: `**${miles(g.roles.cache.size)}**`, inline: true },
        { name: '😀 Emojis y stickers', value: `**${miles(g.emojis.cache.size)}** emojis · **${g.stickers.cache.size}** stickers`, inline: true },
        { name: '🚀 Boosts', value: progresoBoosts(g.premiumSubscriptionCount ?? 0, g.premiumTier), inline: true },
        { name: '🛡️ Seguridad', value: `Verificación: **${nivelVerificacion(g.verificationLevel)}**\n2FA del staff: **${g.mfaLevel ? 'Requerida' : 'Opcional'}**`, inline: true },
        {
          name: '✨ Extras',
          value:
            (g.partnered ? '🤝 Partner de Discord\n' : '') +
            (g.verified ? '✔️ Server verificado\n' : '') +
            (g.vanityURLCode ? `🔗 Invitación: \`${g.vanityURLCode}\`\n` : '') +
            (!g.partnered && !g.verified && !g.vanityURLCode ? '*Nada especial aún*' : '').trim(),
          inline: true,
        },
      ],
      footer: `TriggerBOT • ID del servidor: ${g.id}`,
    });

    // Banner del server si tiene: la imagen de la ficha.
    const banner = g.bannerURL({ size: 1024 });
    if (banner) embed.setImage(banner);

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
