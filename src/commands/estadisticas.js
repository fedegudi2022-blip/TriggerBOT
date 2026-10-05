const { SlashCommandBuilder } = require('discord.js');
const { datosDe, xpParaNivel, posicion, totalUsuarios, rangoDe, multiplicador, LOGROS, XP_PROMEDIO, logrosConProgreso } = require('../niveles');
const { brandEmbed, miles } = require('../utils/replies');

// Barra de progreso ASCII entre el nivel actual y el siguiente (20 celdas: más detalle).
function barra(xp, nivel) {
  const actual = xpParaNivel(nivel);
  const siguiente = xpParaNivel(nivel + 1);
  const progreso = Math.min(Math.max((xp - actual) / (siguiente - actual), 0), 1);
  const llenos = Math.round(progreso * 20);
  return `${'█'.repeat(llenos)}${'░'.repeat(20 - llenos)}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('estadisticas')
    .setDescription('Muestra tu ficha de niveles: XP, nivel, rango, racha y logros')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar (vacío = vos)')),

  // `usuario` se pasa ya resuelto: así el mismo render lo usan el comando slash y el
  // comando de menú contextual (click derecho sobre alguien → Ficha de niveles).
  async ejecutar(interaction, usuario = null) {
    const user = usuario ?? interaction.options.getUser('usuario') ?? interaction.user;
    const guildId = interaction.guild.id;
    const datos = datosDe(guildId, user.id);
    const puesto = posicion(guildId, user.id);
    const rango = rangoDe(datos.nivel);
    const bono = multiplicador(datos.racha);
    const logrosObtenidos = datos.logros ?? [];

    const siguienteNivel = datos.nivel + 1;
    const xpSiguiente = xpParaNivel(siguienteNivel);
    const faltan = Math.max(xpSiguiente - datos.xp, 0);
    const mensajes = Math.ceil(faltan / XP_PROMEDIO);
    const porcentaje = Math.round(((datos.xp - xpParaNivel(datos.nivel)) / (xpSiguiente - xpParaNivel(datos.nivel))) * 100);

    // XP que ya pagaron los logros cobrados.
    const ganadoLogros = LOGROS.filter((l) => logrosObtenidos.includes(l.id)).reduce((s, l) => s + (l.premio || 0), 0);

    // Próximos logros: los tres más cercanos, con lo que falta. La lista completa vive en
    // /logros: acá entraban los 16 renglones con [x]/[ ] en dos columnas, que era el
    // bloque más ilegible de la ficha y el que menos se leía.
    const pendientes = logrosConProgreso(datos);
    const proximos = pendientes.slice(0, 3);
    const lineaProximo = ({ logro, faltan: restan, unidad }) =>
      `**${logro.nombre}** — faltan **${miles(restan)} ${unidad}** · +${miles(logro.premio || 0)} XP`;

    const embed = brandEmbed({
      color: rango.color,
      title: `Perfil de niveles — ${user.username}`,
      thumbnail: user.displayAvatarURL({ size: 256 }),
      description:
        `**${rango.nombre}** · Nivel **${datos.nivel}** · Puesto **#${puesto || '—'}** de ${miles(totalUsuarios(guildId))}\n` +
        `**${miles(datos.xp)} XP** de ${miles(xpSiguiente)} · faltan **${miles(faltan)}** (~${miles(mensajes)} mensajes)`,
      fields: [
        { name: 'Progreso al siguiente nivel', value: `\`${barra(datos.xp, datos.nivel)}\` ${porcentaje}%`, inline: false },
        { name: 'Mensajes', value: `**${miles(datos.mensajes)}**`, inline: true },
        { name: 'Racha', value: `**${datos.racha || 0}** día(s)`, inline: true },
        { name: `Logros ${logrosObtenidos.length}/${LOGROS.length}`, value: `**${miles(ganadoLogros)} XP** cobrados`, inline: true },
        {
          name: 'Bonus activos',
          value: bono.partes.length ? bono.partes.join(' · ') + ` → total **x${bono.total.toFixed(2)}**` : 'Ninguno ahora (activá racha con actividad diaria)',
          inline: false,
        },
        ...(proximos.length
          ? [{ name: `Próximos logros (${pendientes.length} en progreso)`, value: proximos.map(lineaProximo).join('\n'), inline: false }]
          : []),
      ],
      footer: 'TriggerBOT • ganás XP escribiendo (máx. 1 mensaje por minuto) • /logros para el detalle completo',
    });

    return interaction.editReply({ embeds: [embed] });
  },

  async execute(interaction) {
    await interaction.deferReply();
    return module.exports.ejecutar(interaction);
  },
};
