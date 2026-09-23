const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { ranking, rangoDe } = require('../niveles');
const { brandEmbed, miles, COLORS } = require('../utils/replies');

const MEDALLAS = ['🥇', '🥈', '🥉'];
const POR_PAGINA = 10;
const MAX_PAGINAS = 10;

// Emoji por rango, igual que en /estadisticas.
const EMOJI_RANGO = { Leyenda: '👑', Veterano: '🛡️', Experto: '🌟', Activo: '⚡', Novato: '🌱' };

// Construye el embed y las filas de botones para una página del ranking.
// Lo usa tanto /top como el botón de página (interaction puede ser slash o botón).
async function ejecutar(interaction, paginaPedida = 1) {
  const esBoton = interaction.isButton?.() ?? false;
  const guild = interaction.guild;

  // Solo cuenta gente con XP real: las entradas en 0 no deberían ocupar podio.
  const conXP = ranking(guild.id, 9999).filter((e) => e.xp > 0);
  const paginas = Math.max(1, Math.min(MAX_PAGINAS, Math.ceil(conXP.length / POR_PAGINA)));
  const pagina = Math.min(Math.max(paginaPedida, 1), paginas);
  const desde = (pagina - 1) * POR_PAGINA;
  const lista = conXP.slice(desde, desde + POR_PAGINA);

  if (!lista.length) {
    if (esBoton) {
      // No debería pasar (las páginas se calculan con datos reales), pero por las dudas.
      return interaction.update({ components: [] });
    }
    return interaction.reply({
      content: 'Todavía no hay datos de actividad en este rango.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const fila = (e, i) => {
    const pos = desde + i + 1;
    const medalla = MEDALLAS[pos - 1] ?? `\`#${pos}\``;
    const rango = EMOJI_RANGO[rangoDe(e.nivel).nombre] ?? '🎖️';
    const yo = e.userId === interaction.user.id ? ' ✨' : '';
    return `${medalla} <@${e.userId}>${yo} — **nivel ${e.nivel}** ${rango} · ${miles(e.xp)} XP · ${miles(e.mensajes)} msj`;
  };

  // Podio destacado arriba; el resto en columnas de a 3 con posición numérica.
  const podio = lista.slice(0, 3).map(fila).join('\n');
  const resto = lista.slice(3);
  const columnas = [];
  for (let i = 0; i < resto.length; i += 3)
    columnas.push(
      resto
        .slice(i, i + 3)
        .map(fila)
        .join('\n')
    );

  const embed = brandEmbed({
    color: COLORS.warn,
    title: `🏆 Ranking de actividad — página ${pagina}/${paginas}`,
    thumbnail: guild.iconURL({ size: 256 }) ?? undefined,
    description: podio,
    fields: columnas.map((valor) => ({ name: '\u200b', value: valor, inline: true })),
    footer: `TriggerBOT • /estadisticas para tu ficha completa • /logros para el progreso de logros`,
  });

  // Botones de página solo si hay más de una.
  const componentes = [];
  if (paginas > 1) {
    componentes.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`top:page:${pagina - 1}`)
          .setLabel('Anterior')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(pagina <= 1),
        new ButtonBuilder()
          .setCustomId(`top:page:${pagina + 1}`)
          .setLabel('Siguiente')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(pagina >= paginas)
      )
    );
  }

  if (esBoton) return interaction.update({ embeds: [embed], components: componentes });
  return interaction.reply({ embeds: [embed], components: componentes });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('top')
    .setDescription('Ranking de actividad del servidor (con podio y páginas)')
    .addIntegerOption((o) =>
      o.setName('pagina').setDescription(`Página del ranking (${POR_PAGINA} por página)`).setMinValue(1).setMaxValue(MAX_PAGINAS)
    ),

  async execute(interaction) {
    const pagina = interaction.options.getInteger('pagina') ?? 1;
    return ejecutar(interaction, pagina);
  },

  ejecutar,
};
