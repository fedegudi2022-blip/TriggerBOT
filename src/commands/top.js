const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { ranking, rankingPeriodo, rangoDe, rangoPeriodo, XP_PROMEDIO } = require('../niveles');
const { brandEmbed, miles, COLORS } = require('../utils/replies');

const POR_PAGINA = 10;
const MAX_PAGINAS = 10;
const TOPE = POR_PAGINA * MAX_PAGINAS; // el ranking se corta a 100 a propósito

// El acumulado sigue siendo el valor por defecto: los botones viejos
// (`top:page:2`) y los enlaces ya publicados no cambian de significado.
const PERIODOS = {
  acumulado: { etiqueta: 'acumulado', titulo: 'Ranking de actividad' },
  semana: { etiqueta: 'esta semana', titulo: 'Ranking semanal' },
  mes: { etiqueta: 'este mes', titulo: 'Ranking mensual' },
};

function periodoValido(valor) {
  return PERIODOS[valor] ? valor : 'acumulado';
}

// El ranking nombra a diez personas por página: sin esto Discord las notifica a todas
// cada vez que alguien mira el /top. `parse: []` desactiva el aviso pero NO el nombre:
// la mención se sigue viendo igual, solo deja de sonarle el celular a diez personas.
const SIN_PINGS = { parse: [] };

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
function lineaPropia(conXP, indice, total, periodo = 'acumulado') {
  const cuando = periodo === 'semana' ? ' esta semana' : periodo === 'mes' ? ' este mes' : '';
  if (indice < 0) {
    return `No aparecés todavía en el ranking${cuando}: escribí en el server para empezar a sumar XP.`;
  }

  const yo = conXP[indice];
  if (indice === 0) {
    const segundo = conXP[1];
    return segundo
      ? `Vas **#1** de ${miles(total)}${cuando} · ${miles(yo.xp - segundo.xp)} XP de ventaja sobre <@${segundo.userId}> (#2)`
      : `Vas **#1** de ${miles(total)}${cuando} · el ranking recién arranca`;
  }

  const arriba = conXP[indice - 1];
  const faltan = Math.max(arriba.xp - yo.xp, 0);
  const mensajes = Math.ceil(faltan / XP_PROMEDIO);
  return `Estás **#${indice + 1}** de ${miles(total)}${cuando} · te faltan **${miles(faltan)} XP** para pasar a <@${arriba.userId}> (#${indice}) (~${miles(mensajes)} mensajes)`;
}

// customId de los botones: `top:page:<n>` (acumulado, formato viejo) o
// `top:page:<periodo>:<n>`. Se aceptan los dos para no romper paneles ya publicados.
function paginaDeCustomId(customId) {
  const partes = String(customId ?? '').split(':');
  return Number(partes[3] ?? partes[2]) || 1;
}

function periodoDeCustomId(customId) {
  const partes = String(customId ?? '').split(':');
  return partes[3] ? periodoValido(partes[2]) : 'acumulado';
}

// Construye el embed y las filas de botones para una página del ranking.
// Lo usa tanto /top como el botón de página (interaction puede ser slash o botón).
async function ejecutar(interaction, paginaPedida = 1, periodoPedido = 'acumulado') {
  const esBoton = interaction.isButton?.() ?? false;
  const guild = interaction.guild;
  // En un botón manda el customId: la página y el período viajan ahí, no en la
  // interacción (el botón no tiene "options").
  const periodo = esBoton ? periodoDeCustomId(interaction.customId) : periodoValido(periodoPedido);
  const pagina = esBoton ? paginaDeCustomId(interaction.customId) : paginaPedida;
  const meta = PERIODOS[periodo];

  // Solo cuenta gente con XP real en el período: las entradas en 0 no ocupan podio.
  // En el acumulado se usa la caché de siempre; semana y mes suman `xpPorDia` y no
  // tocan el ranking histórico.
  const conXP = (periodo === 'acumulado' ? ranking(guild.id, 9999) : rankingPeriodo(guild.id, periodo, 9999)).filter((e) => e.xp > 0);
  const total = conXP.length;
  const paginas = Math.max(1, Math.min(MAX_PAGINAS, Math.ceil(total / POR_PAGINA)));
  const paginaActual = Math.min(Math.max(pagina, 1), paginas);
  const desde = (paginaActual - 1) * POR_PAGINA;
  const lista = conXP.slice(desde, desde + POR_PAGINA);

  if (!lista.length) {
    if (esBoton) {
      // No debería pasar (las páginas se calculan con datos reales), pero por las dudas.
      return interaction.update({ components: [] });
    }
    return interaction.reply({
      content:
        periodo === 'acumulado'
          ? 'Todavía no hay actividad registrada en este servidor: el ranking se arma con la XP que se gana escribiendo (máximo un mensaje por minuto).'
          : `Todavía no hay actividad registrada ${meta.etiqueta}: el ranking se arma con la XP que se gana escribiendo.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: SIN_PINGS,
    });
  }

  // Cuánta gente hay en total y, si hay más de la que se puede listar, que se note.
  const rango = rangoPeriodo(periodo);
  const encabezado =
    `${miles(total)} ${total === 1 ? 'jugador' : 'jugadores'} con actividad` +
    (periodo === 'acumulado' ? '' : ` ${meta.etiqueta}`) +
    (rango ? ` · desde el ${rango.desde.split('-').reverse().join('/')}` : '') +
    (total > TOPE ? ` · se listan los primeros ${TOPE}` : '');

  const embed = brandEmbed({
    color: COLORS.warn,
    title: `${meta.titulo} — página ${paginaActual}/${paginas}`,
    thumbnail: guild.iconURL({ size: 256 }) ?? undefined,
    description: [
      encabezado,
      '',
      ...lista.map((e, i) => fila(e, desde + i + 1, interaction.user.id)),
      '',
      lineaPropia(conXP, conXP.findIndex((e) => e.userId === interaction.user.id), total, periodo),
    ].join('\n'),
    footer:
      periodo === 'acumulado'
        ? 'TriggerBOT • /estadisticas para tu ficha completa • /logros para el progreso de logros'
        : `TriggerBOT • ranking ${meta.etiqueta} (desde el ${rango?.desde.split('-').reverse().join('/')}) • el acumulado sigue en /top`,
  });

  // Botones de página solo si hay más de una.
  const componentes = [];
  if (paginas > 1) {
    const prefijo = periodo === 'acumulado' ? 'top:page' : `top:page:${periodo}`;
    componentes.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${prefijo}:${paginaActual - 1}`)
          .setLabel('Anterior')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(paginaActual <= 1),
        new ButtonBuilder()
          .setCustomId(`${prefijo}:${paginaActual + 1}`)
          .setLabel('Siguiente')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(paginaActual >= paginas)
      )
    );
  }

  if (esBoton) return interaction.update({ embeds: [embed], components: componentes, allowedMentions: SIN_PINGS });
  return interaction.reply({ embeds: [embed], components: componentes, allowedMentions: SIN_PINGS });
}

module.exports = {
  // El ranking se arma de la caché, pero el filtro recorre hasta 4 000 entradas:
  // 3 s por usuario evitan que un canal entero lo pida al mismo tiempo.
  cooldown: 3,
  data: new SlashCommandBuilder()
    .setName('top')
    .setDescription('Ranking de actividad del servidor (con podio, tu puesto y páginas)')
    .addStringOption((o) =>
      o
        .setName('periodo')
        .setDescription('Acumulado (por defecto), esta semana o este mes')
        .addChoices({ name: 'Acumulado (histórico)', value: 'acumulado' }, { name: 'Esta semana (desde el lunes)', value: 'semana' }, { name: 'Este mes', value: 'mes' })
    )
    .addIntegerOption((o) =>
      o.setName('pagina').setDescription(`Página del ranking (${POR_PAGINA} por página)`).setMinValue(1).setMaxValue(MAX_PAGINAS)
    ),

  async execute(interaction) {
    const pagina = interaction.options.getInteger('pagina') ?? 1;
    const periodo = interaction.options.getString?.('periodo') ?? 'acumulado';
    return ejecutar(interaction, pagina, periodo);
  },

  ejecutar,
};
