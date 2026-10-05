const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { ranking, rangoDe, XP_PROMEDIO } = require('../niveles');
const { brandEmbed, miles, COLORS } = require('../utils/replies');

const POR_PAGINA = 10;
const MAX_PAGINAS = 10;
const TOPE = POR_PAGINA * MAX_PAGINAS; // el ranking se corta a 100 a propósito

// Un renglón por usuario, a todo el ancho del embed. Antes los puestos 4+ se repartían en
// tres campos inline (un tercio del ancho cada uno) y cada renglón se cortaba al medio,
// así que la tabla era ilegible. El podio va entero en negrita; del 4º para abajo solo se
// resalta el puesto, así el ranking se lee de un vistazo sin llenarse de negritas.
function fila(entrada, puesto, userId) {
  const rango = rangoDe(entrada.nivel);
  const vos = entrada.userId === userId ? ' (vos)' : '';
  const resto = `<@${entrada.userId}>${vos} — ${rango.nombre} · nivel ${entrada.nivel} · ${miles(entrada.xp)} XP · ${miles(entrada.mensajes)} msj`;
  return puesto <= 3 ? `**#${puesto} ${resto}**` : `**#${puesto}** ${resto}`;
}

// La línea que más se usa de un ranking: dónde estás y a quién hay que alcanzar. Sin
// esto, mirar el /top era mirar una lista de otros.
function lineaPropia(conXP, indice, total) {
  if (indice < 0) return 'No aparecés todavía en el ranking: escribí en el server para empezar a sumar XP.';

  const yo = conXP[indice];
  if (indice === 0) {
    const segundo = conXP[1];
    return segundo
      ? `Vas **#1** de ${miles(total)} · ${miles(yo.xp - segundo.xp)} XP de ventaja sobre <@${segundo.userId}> (#2)`
      : `Vas **#1** de ${miles(total)} · el ranking recién arranca`;
  }

  const arriba = conXP[indice - 1];
  const faltan = Math.max(arriba.xp - yo.xp, 0);
  const mensajes = Math.ceil(faltan / XP_PROMEDIO);
  return `Estás **#${indice + 1}** de ${miles(total)} · te faltan **${miles(faltan)} XP** para pasar a <@${arriba.userId}> (#${indice}) (~${miles(mensajes)} mensajes)`;
}

// Construye el embed y las filas de botones para una página del ranking.
// Lo usa tanto /top como el botón de página (interaction puede ser slash o botón).
async function ejecutar(interaction, paginaPedida = 1) {
  const esBoton = interaction.isButton?.() ?? false;
  const guild = interaction.guild;

  // Solo cuenta gente con XP real: las entradas en 0 no deberían ocupar podio.
  const conXP = ranking(guild.id, 9999).filter((e) => e.xp > 0);
  const total = conXP.length;
  const paginas = Math.max(1, Math.min(MAX_PAGINAS, Math.ceil(total / POR_PAGINA)));
  const pagina = Math.min(Math.max(paginaPedida, 1), paginas);
  const desde = (pagina - 1) * POR_PAGINA;
  const lista = conXP.slice(desde, desde + POR_PAGINA);

  if (!lista.length) {
    if (esBoton) {
      // No debería pasar (las páginas se calculan con datos reales), pero por las dudas.
      return interaction.update({ components: [] });
    }
    return interaction.reply({
      content:
        'Todavía no hay actividad registrada en este servidor: el ranking se arma con la XP que se gana escribiendo (máximo un mensaje por minuto).',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Cuánta gente hay en total y, si hay más de la que se puede listar, que se note.
  const encabezado =
    `${miles(total)} ${total === 1 ? 'jugador' : 'jugadores'} con actividad` + (total > TOPE ? ` · se listan los primeros ${TOPE}` : '');

  const embed = brandEmbed({
    color: COLORS.warn,
    title: `Ranking de actividad — página ${pagina}/${paginas}`,
    thumbnail: guild.iconURL({ size: 256 }) ?? undefined,
    description: [
      encabezado,
      '',
      ...lista.map((e, i) => fila(e, desde + i + 1, interaction.user.id)),
      '',
      lineaPropia(conXP, conXP.findIndex((e) => e.userId === interaction.user.id), total),
    ].join('\n'),
    footer: 'TriggerBOT • /estadisticas para tu ficha completa • /logros para el progreso de logros',
  });

  // Botones de página solo si hay más de una.
  const componentes = [];
  if (paginas > 1) {
    componentes.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`top:page:${pagina - 1}`)
          .setLabel('Anterior')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(pagina <= 1),
        new ButtonBuilder()
          .setCustomId(`top:page:${pagina + 1}`)
          .setLabel('Siguiente')
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
    .setDescription('Ranking de actividad del servidor (con podio, tu puesto y páginas)')
    .addIntegerOption((o) =>
      o.setName('pagina').setDescription(`Página del ranking (${POR_PAGINA} por página)`).setMinValue(1).setMaxValue(MAX_PAGINAS)
    ),

  async execute(interaction) {
    const pagina = interaction.options.getInteger('pagina') ?? 1;
    return ejecutar(interaction, pagina);
  },

  ejecutar,
};
