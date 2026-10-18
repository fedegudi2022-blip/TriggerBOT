// /sorteo — sorteos comunitarios con panel, botones y cierre automático.
//
// El staff crea el sorteo (premio, duración, ganadores y, si quiere, un rol como
// requisito) y el bot publica un panel público en el canal. La comunidad participa con
// los botones del panel; el botón no pasa por acá, lo maneja utils/sorteos.js.
//
// Todos los subcomandos son de staff: la comunidad interactúa con los botones del panel.
// Así el comando no aparece "usable" para quien solo quiere anotarse y no puede crear
// sorteos por error.
const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const sorteos = require('../utils/sorteos');
const { brandEmbed, successEmbed, errorEmbed, COLORS, miles, marcaTiempo } = require('../utils/replies');
const { exigirStaff } = require('../utils/permisos');

const POR_LISTA = 10;

// Texto corto de cada sorteo para /sorteo lista.
function lineaDeSorteo(sorteo) {
  const participantes = miles(sorteo.participantes?.length ?? 0);
  if (sorteo.estado === 'abierto') {
    return `**#${sorteo.id} · ${sorteo.premio}** — ${participantes} participantes, termina ${marcaTiempo(sorteo.hasta, 'R')}`;
  }
  const ganadores = sorteo.ganadoresElegidos ?? [];
  const resultado = ganadores.length ? ganadores.map((id) => `<@${id}>`).join(', ') : 'desierto';
  return `**#${sorteo.id} · ${sorteo.premio}** — ${sorteo.estado} (${resultado})`;
}

module.exports = {
  // Publicar un sorteo y cerrarlo tocan la API en varios pasos: 3 s por usuario.
  cooldown: 3,

  data: new SlashCommandBuilder()
    .setName('sorteo')
    .setDescription('Sorteos de la comunidad: crea uno, consultá los activos o elegí ganadores')
    .addSubcommand((sub) =>
      sub
        .setName('crear')
        .setDescription('Publica un sorteo con botón de participación en el canal')
        .addStringOption((o) => o.setName('premio').setDescription('Qué se sortea (ej: skin, rango VIP, un mes de…).').setRequired(true).setMaxLength(200))
        .addStringOption((o) =>
          o.setName('duracion').setDescription('Cuánto dura: 30m, 2h, 7d (mín. 1 min, máx. 30 días)').setRequired(true).setMaxLength(10)
        )
        .addIntegerOption((o) =>
          o.setName('ganadores').setDescription('Cuántos ganadores (1-10, por defecto 1)').setMinValue(1).setMaxValue(10)
        )
        .addRoleOption((o) => o.setName('rol').setDescription('Requisito opcional: solo participa quien tenga este rol'))
        .addChannelOption((o) =>
          o
            .setName('canal')
            .setDescription('Dónde publicar el panel (vacío = este canal)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('terminar')
        .setDescription('Cierra un sorteo ahora y anuncia a los ganadores')
        .addIntegerOption((o) => o.setName('id').setDescription('Número del sorteo (/sorteo lista)').setRequired(true).setMinValue(1))
    )
    .addSubcommand((sub) =>
      sub
        .setName('reroll')
        .setDescription('Vuelve a sortear un sorteo terminado, sin repetir ganadores si se puede')
        .addIntegerOption((o) => o.setName('id').setDescription('Número del sorteo').setRequired(true).setMinValue(1))
    )
    .addSubcommand((sub) =>
      sub
        .setName('cancelar')
        .setDescription('Cancela un sorteo abierto sin elegir ganadores')
        .addIntegerOption((o) => o.setName('id').setDescription('Número del sorteo').setRequired(true).setMinValue(1))
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Muestra los sorteos abiertos y los últimos resultados')),

  async execute(interaction) {
    const guildId = interaction.guildId ?? interaction.guild?.id;
    if (!guildId) {
      return interaction.reply({ embeds: [errorEmbed('Los sorteos solo funcionan dentro de un servidor.')], flags: MessageFlags.Ephemeral });
    }
    if (!(await exigirStaff(interaction))) return;

    const sub = interaction.options.getSubcommand();

    if (sub === 'crear') return crear(interaction, guildId);
    if (sub === 'lista') return listar(interaction, guildId);
    if (sub === 'terminar') return terminar(interaction, guildId);
    if (sub === 'reroll') return reroll(interaction, guildId);
    if (sub === 'cancelar') return cancelar(interaction, guildId);

    return interaction.reply({ embeds: [errorEmbed('Ese subcomando no existe.')], flags: MessageFlags.Ephemeral });
  },
};

async function crear(interaction, guildId) {
  const premio = interaction.options.getString('premio', true);
  const duracionTexto = interaction.options.getString('duracion', true);
  const duracionMs = sorteos.parsearDuracion(duracionTexto);

  if (!duracionMs) {
    return interaction.reply({
      embeds: [errorEmbed('La duración no es válida. Usá `30m`, `2h` o `7d` (de 1 minuto a 30 días).')],
      flags: MessageFlags.Ephemeral,
    });
  }

  const canal = interaction.options.getChannel('canal') ?? interaction.channel;
  if (!canal?.send) {
    return interaction.reply({ embeds: [errorEmbed('No pude publicar el panel en ese canal.')], flags: MessageFlags.Ephemeral });
  }

  const rol = interaction.options.getRole('rol');
  const ganadores = interaction.options.getInteger('ganadores') ?? 1;

  const resultado = sorteos.crear(guildId, {
    premio,
    hasta: Date.now() + duracionMs,
    ganadores,
    rolId: rol?.id ?? null,
    canalId: canal.id,
    creadorId: interaction.user.id,
  });

  if (resultado.error) {
    return interaction.reply({ embeds: [errorEmbed(resultado.error)], flags: MessageFlags.Ephemeral });
  }

  const { embed, components } = sorteos.vista(resultado.sorteo);
  let mensaje = null;
  try {
    mensaje = await canal.send({ embeds: [embed], components, allowedMentions: { parse: [] } });
  } catch (error) {
    // Sin panel publicado el sorteo no existe para nadie: se cancela para no dejarlo
    // contando como "abierto" y ocupando el cupo.
    sorteos.cancelar(guildId, resultado.sorteo.id);
    return interaction.reply({
      embeds: [errorEmbed(`No pude publicar el panel en <#${canal.id}>: ${error.message}`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (mensaje?.id) sorteos.adjuntarMensaje(guildId, resultado.sorteo.id, mensaje.id);

  const enlace = mensaje?.id ? `https://discord.com/channels/${guildId}/${canal.id}/${mensaje.id}` : null;
  return interaction.reply({
    embeds: [
      successEmbed(
        `Sorteo **#${resultado.sorteo.id}** publicado en <#${canal.id}>.\n` +
          `Termina ${marcaTiempo(resultado.sorteo.hasta, 'R')} · ${ganadores} ganador${ganadores === 1 ? '' : 'es'}` +
          (rol ? ` · solo con el rol ${rol}` : '') +
          (enlace ? `\n\n[Ir al panel](${enlace})` : ''),
        'Sorteo creado'
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function listar(interaction, guildId) {
  const todos = sorteos.lista(guildId);
  const abiertos = todos.filter((s) => s.estado === 'abierto');
  const cerrados = todos.filter((s) => s.estado !== 'abierto').slice(-POR_LISTA).reverse();

  if (!todos.length) {
    return interaction.reply({
      embeds: [brandEmbed({ color: COLORS.info, title: 'Sorteos', description: 'Todavía no hay sorteos en este servidor. Creá uno con `/sorteo crear`.' })],
      flags: MessageFlags.Ephemeral,
    });
  }

  const campos = [];
  if (abiertos.length) campos.push({ name: `Abiertos (${abiertos.length})`, value: abiertos.map((s) => lineaDeSorteo(s)).join('\n').slice(0, 1024) });
  if (cerrados.length) campos.push({ name: 'Últimos resultados', value: cerrados.map((s) => lineaDeSorteo(s)).join('\n').slice(0, 1024) });

  return interaction.reply({
    embeds: [
      brandEmbed({
        color: COLORS.info,
        title: 'Sorteos del servidor',
        fields: campos,
        footer: 'TriggerBOT • /sorteo terminar|reroll|cancelar id para gestionar uno',
      }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function terminar(interaction, guildId) {
  const id = interaction.options.getInteger('id', true);
  const resultado = sorteos.finalizar(guildId, id, { forzar: true });
  if (resultado.error) {
    return interaction.reply({ embeds: [errorEmbed(resultado.error)], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await sorteos.refrescarMensaje(interaction.client, resultado.sorteo);
  await sorteos.anunciar(interaction.client, resultado.sorteo, { titulo: '🎉 Sorteo finalizado' });

  const ganadores = resultado.ganadores;
  return interaction.editReply({
    embeds: [
      successEmbed(
        ganadores.length
          ? `Sorteo **#${id}** cerrado. Ganador${ganadores.length === 1 ? '' : 'es'}: ${ganadores.map((uid) => `<@${uid}>`).join(', ')}`
          : `Sorteo **#${id}** cerrado, pero nadie participó: quedó desierto.`,
        'Resultado publicado'
      ),
    ],
  });
}

async function reroll(interaction, guildId) {
  const id = interaction.options.getInteger('id', true);
  const resultado = sorteos.reroll(guildId, id);
  if (resultado.error) {
    return interaction.reply({ embeds: [errorEmbed(resultado.error)], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await sorteos.refrescarMensaje(interaction.client, resultado.sorteo);
  await sorteos.anunciar(interaction.client, resultado.sorteo, { titulo: '🔄 Nuevo sorteo (reroll)' });

  return interaction.editReply({
    embeds: [
      successEmbed(
        `Sorteo **#${id}** vuelto a sortear. Nuevo${resultado.ganadores.length === 1 ? '' : 's'} ganador${
          resultado.ganadores.length === 1 ? '' : 'es'
        }: ${resultado.ganadores.map((uid) => `<@${uid}>`).join(', ')}`,
        'Reroll hecho'
      ),
    ],
  });
}

async function cancelar(interaction, guildId) {
  const id = interaction.options.getInteger('id', true);
  const resultado = sorteos.cancelar(guildId, id);
  if (resultado.error) {
    return interaction.reply({ embeds: [errorEmbed(resultado.error)], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await sorteos.refrescarMensaje(interaction.client, resultado.sorteo);

  return interaction.editReply({
    embeds: [successEmbed(`Sorteo **#${id}** cancelado. El panel quedó en el canal, sin botones.`, 'Sorteo cancelado')],
  });
}
