const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ChannelType,
  MessageFlags,
} = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { brandEmbed, errorEmbed, COLORS } = require('./replies');
const { nivelStaff, esStaff } = require('./permisos');
const {
  POR_DEFECTO: PROTECCION_DEFECTO,
  configDe: configProteccion,
  normalizarDominios,
  FILTROS: FILTROS_AUTOMOD,
  LIMITES_FILTROS,
} = require('./proteccion');
const { ACCIONES: ACCIONES_ESCALADA, LIMITES: LIMITES_ESCALADA, resolver: resolverEscalada, describir: describirEscalada } = require('./escalada');

// ---------- Definición de secciones ----------
const SECCIONES = [
  { value: 'bienvenida', label: 'Bienvenida y autorol', description: 'Canal, mensaje y rol automático para nuevos miembros' },
  { value: 'modlog', label: 'Mod-log', description: 'Canal de registro de acciones de moderación' },
  { value: 'logs', label: 'Logs de eventos', description: 'Mensajes borrados/editados, salidas, roles y apodos' },
  { value: 'avisos', label: 'Avisos al staff', description: 'Canal de notificaciones para el equipo' },
  { value: 'staff', label: 'Roles de staff', description: 'Quiénes son admin, mod y helper para el bot' },
  { value: 'mute', label: 'Rol de silenciado', description: 'Rol que usa /mute (si no hay, se crea uno solo)' },
  {
    value: 'escalada',
    label: 'Escalada de avisos',
    description: 'Qué pasa cuando alguien acumula advertencias',
  },
  { value: 'ia', label: 'Chat con IA', description: 'Prender o apagar las respuestas al mencionar al bot' },
  { value: 'niveles', label: 'Niveles y XP', description: 'Canal donde se anuncian subidas de nivel y logros' },
  { value: 'frases', label: 'Frase del día', description: 'Canal y hora de la frase automática diaria' },
  { value: 'proteccion', label: 'Anti-spam y anti-raid', description: 'Flood y oleadas de ingresos con acción automática' },
  { value: 'servidores', label: 'Servidores CS 1.6', description: 'Servers con IP, panel en vivo y alertas de caída' },
  { value: 'tickets', label: 'Tickets de soporte', description: 'Categoría, canal de logs y panel con botón' },
  { value: 'desactivar', label: 'Desactivar funciones', description: 'Apagar funciones que ya no querés usar' },
];

const NOMBRE_SECCION = Object.fromEntries(SECCIONES.map((s) => [s.value, s.label]));

// Secciones que NO son configuración rutinaria: tocar los roles de staff, la
// escalada de warns o las defensas anti-spam/raid puede ampliar privilegios o
// debilitar el servidor, así que quedan reservadas al admin (dueño, ManageGuild o
// rol admin configurado). El resto lo puede usar cualquier nivel de staff
// (helper/mod/admin): canales, logs, frases, tickets, niveles, servidores, etc.
const SECCIONES_SENSIBLES = new Set(['staff', 'escalada', 'proteccion']);

// ---------- Helpers de filas ----------
function filaMenuPrincipal(interaction) {
  // Un helper/mod no ve las secciones sensibles: el control real está en
  // manejarComponente(), esto solo evita ofrecer lo que igual no puede usar.
  const esAdmin = nivelStaff(interaction) === 'admin';
  const opciones = SECCIONES.filter((s) => esAdmin || !SECCIONES_SENSIBLES.has(s.value)).map((s) => ({
    label: s.label,
    value: s.value,
    description: s.description,
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('cfg:menu').setPlaceholder('Elegí qué querés configurar').addOptions(opciones)
  );
}

function filaVolver() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg:volver').setLabel('Volver al panel').setStyle(ButtonStyle.Secondary)
  );
}

function filaDesactivar(feature) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cfg:off:ask:${feature}`).setLabel('Desactivar').setStyle(ButtonStyle.Danger)
  );
}

function canalActual(valor) {
  return valor ? `<#${valor}>` : '*sin configurar*';
}
function rolActual(valor) {
  return valor ? `<@&${valor}>` : '*sin configurar*';
}

// ---------- Vista del panel principal (resumen + menú) ----------
function panelCompleto(interaction) {
  const guild = interaction.guild;
  const config = getGuildConfig(guild.id);
  const esAdmin = nivelStaff(interaction) === 'admin';

  const estado = (v) => (v ? v : '*sin configurar*');
  const staffLines = ['admin', 'mod', 'helper']
    .map((nivel) => {
      const nombres = { admin: 'Admin', mod: 'Mod', helper: 'Helper' };
      return `• ${nombres[nivel]}: ${rolActual(config[`${nivel}Role`])}`;
    })
    .join('\n');

  const campos = [
    { name: 'Bienvenida', value: estado(config.welcome?.channelId ? `<#${config.welcome.channelId}>` : null), inline: true },
    { name: 'Autorol', value: estado(config.autorole ? `<@&${config.autorole}>` : null), inline: true },
    { name: 'Mod-log', value: estado(config.modlog ? `<#${config.modlog}>` : null), inline: true },
    { name: 'Logs', value: estado(config.logs ? `<#${config.logs}>` : null), inline: true },
    { name: 'Avisos al staff', value: estado(config.avisosChannel ? `<#${config.avisosChannel}>` : null), inline: true },
    { name: 'Rol de silenciado', value: estado(config.muteRole ? `<@&${config.muteRole}>` : null), inline: true },
    { name: 'Chat con IA', value: config.iaActivada === false ? 'Apagada' : 'Prendida', inline: true },
    { name: 'Servidores CS', value: config.servidores?.lista?.length ? `${config.servidores.lista.length} cargado(s)` : 'Sin cargar', inline: true },
    { name: 'Tickets', value: config.tickets?.categoriaId ? `<#${config.tickets.categoriaId}>` : 'Sin configurar', inline: true },
    { name: 'Canal de niveles', value: estado(config.canalNiveles ? `<#${config.canalNiveles}>` : null), inline: true },
    { name: 'Frase del día', value: estado(config.fraseDelDia?.canalId ? `<#${config.fraseDelDia.canalId}>` : null), inline: true },
  ];
  if (esAdmin) {
    // El resumen de las secciones sensibles se muestra solo a quien puede editarlas.
    campos.push({ name: 'Anti-spam/raid', value: config.proteccion?.activado ? 'Prendida' : 'Apagada', inline: true });
    campos.push({ name: 'Staff del bot', value: staffLines, inline: false });
  }

  const embed = new EmbedBuilder()
    .setTitle('Configuración del servidor')
    .setColor(COLORS.info)
    .setDescription(
      'Usá el menú de abajo para configurar cada sección. Todo se guarda al instante.' +
        (esAdmin ? '' : '\n\nLas secciones de staff, escalada y anti-spam/raid las configura solo un admin.')
    )
    .addFields(campos)
    .setFooter({ text: 'TriggerBOT' })
    .setTimestamp();

  return { embeds: [embed], components: [filaMenuPrincipal(interaction)] };
}

// ---------- Vistas por sección ----------
function vistaSeccion(interaction, seccion, guardado = false) {
  const guild = interaction.guild;
  const config = getGuildConfig(guild.id);
  const esAdmin = nivelStaff(interaction) === 'admin';

  // Defensa en profundidad: el menú ya no ofrece las secciones sensibles a un
  // helper/mod, pero si llegan por un customId fabricado no se renderiza nada.
  if (SECCIONES_SENSIBLES.has(seccion) && !esAdmin) {
    return {
      embeds: [errorEmbed(`Solo un admin puede ver y configurar **${NOMBRE_SECCION[seccion] ?? seccion}**.`)],
      components: [filaVolver()],
    };
  }

  const nota = guardado ? '\n\n**Guardado.**' : '';
  const components = [];
  let embed;
  // Valores de la sección de protección (por defecto + acotados, igual que los lee
  // el automod: así lo que se ve en el panel es lo que realmente se aplica).
  const p = configProteccion(guild.id);

  if (seccion === 'bienvenida') {
    embed = new EmbedBuilder()
      .setTitle('Bienvenida y autorol')
      .setColor(COLORS.info)
      .setDescription(
        `**Canal:** ${canalActual(config.welcome?.channelId)}\n` +
          `**Autorol:** ${rolActual(config.autorole)}\n` +
          `**Mensaje:** ${config.welcome?.message ? `\n> ${config.welcome.message.slice(0, 400)}` : '*por defecto*'}${nota}`
      )
      .setFooter({ text: 'Variables del mensaje: {usuario} {servidor} {miembros}' });

    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:set:bienvenida:canal')
          .setPlaceholder('Elegí el canal de bienvenida')
          .setChannelTypes(ChannelType.GuildText)
      )
    );
    components.push(
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId('cfg:set:bienvenida:autorol').setPlaceholder('Elegí el rol automático')
      )
    );
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:msg:bienvenida').setLabel('Editar mensaje').setStyle(ButtonStyle.Primary),
        filaDesactivar('bienvenida').components[0]
      )
    );
  } else if (seccion === 'modlog' || seccion === 'logs' || seccion === 'avisos') {
    const datos = {
      modlog: { titulo: 'Mod-log', actual: canalActual(config.modlog), desc: 'Registra kick/ban/timeout/warn/clear/lockdown.' },
      logs: {
        titulo: 'Logs de eventos',
        actual: canalActual(config.logs),
        desc: 'Mensajes borrados/editados, salidas, roles y apodos. Si no hay, usa el mod-log.',
      },
      avisos: { titulo: 'Avisos al staff', actual: canalActual(config.avisosChannel), desc: 'Notificaciones para el equipo de moderación.' },
    }[seccion];

    embed = new EmbedBuilder()
      .setTitle(datos.titulo)
      .setColor(COLORS.info)
      .setDescription(`**Canal actual:** ${datos.actual}\n\n${datos.desc}${nota}`);

    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId(`cfg:set:${seccion}:canal`).setPlaceholder('Elegí el canal').setChannelTypes(ChannelType.GuildText)
      )
    );
    components.push(new ActionRowBuilder().addComponents(filaDesactivar(seccion).components[0], filaVolver().components[0]));
  } else if (seccion === 'staff') {
    embed = new EmbedBuilder()
      .setTitle('Roles de staff')
      .setColor(COLORS.info)
      .setDescription(
        `**Admin:** ${rolActual(config.adminRole)}\n**Mod:** ${rolActual(config.modRole)}\n**Helper:** ${rolActual(config.helperRole)}${nota}\n\n` +
          'El staff puede usar los comandos de moderación y confirmar acciones pedidas por chat con IA.'
      );

    for (const [nivel, placeholder] of [
      ['admin', 'Rol administrador del bot'],
      ['mod', 'Rol moderador del bot'],
      ['helper', 'Rol helper del bot'],
    ]) {
      components.push(
        new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`cfg:set:staff:${nivel}`).setPlaceholder(placeholder))
      );
    }
    components.push(filaVolver());
  } else if (seccion === 'mute') {
    embed = new EmbedBuilder()
      .setTitle('Rol de silenciado')
      .setColor(COLORS.info)
      .setDescription(
        `**Rol actual:** ${rolActual(config.muteRole)}${nota}\n\n` +
          'Si no configurás ninguno, /mute crea y configura uno llamado "Silenciado" automáticamente.'
      );

    components.push(
      new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('cfg:set:mute:rol').setPlaceholder('Elegí el rol de silenciado'))
    );
    components.push(new ActionRowBuilder().addComponents(filaDesactivar('mute').components[0], filaVolver().components[0]));
  } else if (seccion === 'escalada') {
    const e = resolverEscalada(config);

    embed = new EmbedBuilder()
      .setTitle('Escalada de advertencias')
      .setColor(e.activada ? COLORS.info : COLORS.gris)
      .setDescription(
        `**Estado:** ${e.activada ? '🟢 Prendida' : '🔴 Apagada'}${nota}\n\n` +
          `${describirEscalada(e)}\n\n` +
          'La advertencia siempre se guarda en el historial del usuario (se ve con `/warnings`); ' +
          'esto define qué pasa ADEMÁS de guardarla. El DM al usuario refleja solo lo que se aplicó de verdad.'
      )
      .setFooter({ text: `Umbral: ${e.umbral} · Duración: ${e.duracion} min · Acción: ${ACCIONES_ESCALADA[e.accion]}` });

    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cfg:toggle:escalada')
          .setLabel(e.activada ? 'Apagar' : 'Prender')
          .setStyle(e.activada ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cfg:modalpedir:escalada').setLabel('Ajustar umbral y duración').setStyle(ButtonStyle.Primary)
      )
    );

    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:set:escalada:accion')
          .setPlaceholder('Acción al alcanzar el umbral')
          .addOptions(
            Object.entries(ACCIONES_ESCALADA).map(([valor, etiqueta]) => ({
              label: etiqueta,
              value: valor,
              default: e.accion === valor,
            }))
          )
      )
    );
    components.push(filaVolver());
  } else if (seccion === 'ia') {
    const prendida = config.iaActivada !== false;
    embed = new EmbedBuilder()
      .setTitle('Chat con IA')
      .setColor(COLORS.info)
      .setDescription(
        `**Estado:** ${prendida ? 'Prendida' : 'Apagada'}${nota}\n\n` +
          'Cuando alguien menciona al bot, responde con IA. También interpreta pedidos de moderación ' +
          '(el staff confirma cada acción con un botón).'
      );

    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cfg:toggle:ia')
          .setLabel(prendida ? 'Apagar' : 'Prender')
          .setStyle(prendida ? ButtonStyle.Danger : ButtonStyle.Success)
      )
    );
    components.push(filaVolver());
  } else if (seccion === 'niveles' || seccion === 'frases') {
    const esNiveles = seccion === 'niveles';
    const canalId = esNiveles ? config.canalNiveles : config.fraseDelDia?.canalId;
    const extra = esNiveles
      ? 'Ahí se anuncian subidas de nivel y logros desbloqueados. XP por hablar con anti-farm: /estadisticas y /top para consultar.'
      : `**Hora de publicación:** ${config.fraseDelDia?.hora ?? 12}:00 (Argentina)\n**Frases cargadas:** ${config.fraseDelDia?.frases?.length ?? 0}\n\nLa hora y las frases se gestionan con /frases.`;

    embed = new EmbedBuilder()
      .setTitle(esNiveles ? 'Niveles y XP' : 'Frase del día')
      .setColor(COLORS.info)
      .setDescription(`**Canal actual:** ${canalActual(canalId)}\n\n${extra}${nota}`);

    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId(`cfg:set:${seccion}:canal`).setPlaceholder('Elegí el canal').setChannelTypes(ChannelType.GuildText)
      )
    );
    components.push(new ActionRowBuilder().addComponents(filaDesactivar(seccion).components[0], filaVolver().components[0]));
  } else if (seccion === 'proteccion') {
    const { ETIQUETA_ACCION_SPAM, ETIQUETA_ACCION_RAID } = require('./proteccion');
    const OPCIONES_SPAM = [
      { valor: 'aviso', etiqueta: 'Borrar mensajes' },
      { valor: 'timeout', etiqueta: 'Timeout 10 min' },
      { valor: 'mute', etiqueta: 'Silenciar con rol' },
      { valor: 'kick', etiqueta: 'Expulsar' },
      { valor: 'ban', etiqueta: 'Banear' },
    ];
    const OPCIONES_RAID = [
      { valor: 'nada', etiqueta: 'Solo alertar' },
      { valor: 'kick', etiqueta: 'Expulsar' },
      { valor: 'ban', etiqueta: 'Banear' },
    ];

    // Detalle de cada filtro del automod: estado + con qué umbral está trabajando.
    const detalleFiltro = (clave) => {
      if (clave === 'filtroLinks') {
        return p.linksPermitidos.length ? `permitidos: ${p.linksPermitidos.join(', ')}` : 'sin dominios permitidos';
      }
      if (clave === 'filtroMenciones') return `máx. ${p.mencionesMaximas} menciones`;
      if (clave === 'filtroMayusculas') return `${p.mayusculasPorcentaje}% en ${p.mayusculasMinimo}+ letras`;
      if (clave === 'filtroRepetidos') return `${p.repetidosVeces} veces seguidas`;
      return 'links a otros servidores';
    };
    const lineasFiltros = FILTROS_AUTOMOD.map((f) => `• **${f.nombre}:** ${p[f.clave] ? 'Prendido' : 'Apagado'} — ${detalleFiltro(f.clave)}`).join(
      '\n'
    );

    embed = new EmbedBuilder()
      .setTitle('Anti-spam, automod y anti-raid')
      .setColor(COLORS.info)
      .setDescription(
        `**Estado:** ${p.activado ? '🟢 Prendida' : '🔴 Apagada'}${nota}\n\n` +
          `**Spam:** ${p.spamMensajes} mensajes en ${p.spamSegundos} s → **${ETIQUETA_ACCION_SPAM[p.accionSpam] ?? p.accionSpam}**\n` +
          `**Raid:** ${p.raidJoins} ingresos en ${p.raidSegundos} s → **${ETIQUETA_ACCION_RAID[p.accionRaid] ?? p.accionRaid}**\n` +
          `**Auto-acción en raids:** ${p.accionesRapidas ? 'Prendida (actúa sola sobre cuentas nuevas sin roles)' : 'Apagada (solo alerta)'}\n\n` +
          `**Automod por contenido** (borra el mensaje, avisa por DM y deja el caso):\n${lineasFiltros}\n\n` +
          'El staff con permiso de gestionar mensajes está exento del anti-spam y del automod. Las alertas van al canal de avisos (o logs/mod-log si no hay).'
      );

    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cfg:toggle:proteccion')
          .setLabel(p.activado ? 'Apagar' : 'Prender')
          .setStyle(p.activado ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('cfg:toggle:raidAuto')
          .setLabel(p.accionesRapidas ? 'Quitar auto-acción de raids' : 'Actuar sola en raids')
          .setStyle(ButtonStyle.Secondary)
      )
    );
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:set:proteccion:accionSpam')
          .setPlaceholder('Acción ante spam')
          .addOptions(OPCIONES_SPAM.map((o) => ({ label: o.etiqueta, value: o.valor, default: p.accionSpam === o.valor })))
      )
    );
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:set:proteccion:accionRaid')
          .setPlaceholder('Acción ante oleada de ingresos')
          .addOptions(OPCIONES_RAID.map((o) => ({ label: o.etiqueta, value: o.valor, default: p.accionRaid === o.valor })))
      )
    );
    // Un botón por filtro (prendido = verde) + los umbrales en un modal.
    components.push(
      new ActionRowBuilder().addComponents(
        FILTROS_AUTOMOD.map((f) =>
          new ButtonBuilder()
            .setCustomId(`cfg:toggle:proteccion:${f.clave}`)
            .setLabel(p[f.clave] ? `${f.nombre}: prendido` : f.nombre)
            .setStyle(p[f.clave] ? ButtonStyle.Success : ButtonStyle.Secondary)
        )
      )
    );
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:modalpedir:proteccion').setLabel('Ajustar umbrales').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cfg:modalpedir:proteccion:filtros').setLabel('Ajustar filtros').setStyle(ButtonStyle.Primary),
        filaVolver().components[0]
      )
    );
  } else if (seccion === 'servidores') {
    const servidores = config.servidores?.lista ?? [];
    const listaTexto =
      servidores.map((s, i) => `**${i + 1}.** ${s.nombre} — \`${s.host}:${s.puerto}\`${s.modo ? ` (${s.modo})` : ''}`).join('\n') ||
      '*Todavía no hay servers cargados.*';

    embed = new EmbedBuilder()
      .setTitle('Servidores CS 1.6')
      .setColor(COLORS.info)
      .setDescription(
        `**Panel en vivo:** ${canalActual(config.servidores?.canalPanel)}\n` +
          `**Alertas de caída:** ${config.servidores?.monitoreo === false ? 'Apagadas' : 'Prendidas'}\n\n` +
          `**Servers (${servidores.length}):**\n${listaTexto}${nota}\n\n` +
          'Con servers cargados, /servidores e /ip muestran el estado en vivo y el bot avisa al staff si uno cae o vuelve.'
      );

    // Modal para cargar un server nuevo: nombre + IP:puerto + modo.
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:modalpedir:servidores').setLabel('Agregar servidor').setStyle(ButtonStyle.Success)
      )
    );

    // Selector para quitar uno (solo si hay).
    if (servidores.length) {
      components.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('cfg:servers:quitar')
            .setPlaceholder('Elegí el server a quitar')
            .addOptions(
              servidores.map((s, i) => ({
                label: `${i + 1}. ${s.nombre}`.slice(0, 100),
                description: `${s.host}:${s.puerto}`.slice(0, 100),
                value: String(i),
              }))
            )
        )
      );
    }

    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cfg:toggle:servMonitoreo')
          .setLabel(config.servidores?.monitoreo === false ? 'Prender alertas' : 'Apagar alertas')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cfg:servers:limpiarPanel').setLabel('Olvidar panel publicado').setStyle(ButtonStyle.Secondary),
        filaVolver().components[0]
      )
    );
  } else if (seccion === 'tickets') {
    const t = config.tickets || {};
    embed = new EmbedBuilder()
      .setTitle('Tickets de soporte')
      .setColor(COLORS.info)
      .setDescription(
        `**Categoría de tickets:** ${canalActual(t.categoriaId)}\n` +
          `**Canal de transcripts:** ${canalActual(t.canalLogs)}\n` +
          `**Texto del panel:** ${t.mensajes ? 'personalizado' : 'por defecto'}\n\n` +
          'Publicá el panel con `/ticket publicar` en tu canal de soporte: cada usuario abre su canal privado ' +
          'y al cerrarlo el bot guarda el transcript en logs y se lo manda por DM al usuario.'
      );

    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:set:tickets:categoria')
          .setPlaceholder('Elegí la categoría donde se crean los tickets')
          .setChannelTypes(ChannelType.GuildCategory)
      )
    );
    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:set:tickets:logs')
          .setPlaceholder('Elegí el canal de los transcripts')
          .setChannelTypes(ChannelType.GuildText)
      )
    );
    components.push(filaVolver());
  } else if (seccion === 'desactivar') {
    embed = new EmbedBuilder()
      .setTitle('Desactivar funciones')
      .setColor(COLORS.info)
      .setDescription('Elegí la función que querés apagar. Te va a pedir confirmación.');

    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:off:menu')
          .setPlaceholder('Elegí la función a desactivar')
          .addOptions(
            // La escalada tiene su propio interruptor en su sección (apagarla desde
            // acá sería un segundo camino para lo mismo).
            SECCIONES.filter((s) => !['desactivar', 'escalada'].includes(s.value))
              .filter((s) => esAdmin || !SECCIONES_SENSIBLES.has(s.value))
              .map((s) => ({
                label: s.label,
                value: s.value,
              }))
          )
      )
    );
    components.push(filaVolver());
  }

  // El botón "volver" va último en las secciones que no lo agregaron aún.
  if (!components.some((r) => r.components.some((c) => c.data.custom_id === 'cfg:volver'))) {
    components.push(filaVolver());
  }

  return { embeds: [embed], components };
}

// ---------- Vista de confirmación de desactivado ----------
function vistaConfirmarDesactivado(feature) {
  const embed = new EmbedBuilder()
    .setTitle('Confirmar desactivado')
    .setColor(COLORS.warn)
    .setDescription(`¿Seguro que querés desactivar **${NOMBRE_SECCION[feature]}**?`);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cfg:off:si:${feature}`).setLabel('Sí, desactivar').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cfg:volver').setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

// Deduce a qué sección pertenece un componente cfg:* para aplicar la política de
// secciones sensibles sin repetir el chequeo en cada rama. null = no toca ninguna.
function seccionDeComponente(interaction) {
  const partes = interaction.customId.split(':');
  const accion = partes[1];
  if (accion === 'menu') return interaction.values?.[0] ?? null;
  if (accion === 'set' || accion === 'msg' || accion === 'modal' || accion === 'modalpedir') return partes[2] ?? null;
  if (accion === 'toggle') {
    const cual = partes[2];
    if (cual === 'raidAuto') return 'proteccion';
    if (cual === 'servMonitoreo') return 'servidores';
    return cual ?? null;
  }
  if (accion === 'servers') return 'servidores';
  if (accion === 'off') {
    // cfg:off:menu (la sección viene en values) | cfg:off:ask:<feature> | cfg:off:si:<feature>
    return partes[2] === 'menu' ? (interaction.values?.[0] ?? null) : (partes[3] ?? null);
  }
  return null;
}

// ---------- Guardado por sección ----------
function aplicarSet(guildId, seccion, campo, valor) {
  setGuildConfig(guildId, (c) => {
    if (seccion === 'bienvenida' && campo === 'canal') {
      c.welcome = c.welcome || {};
      c.welcome.channelId = valor;
    } else if (seccion === 'bienvenida' && campo === 'autorol') {
      c.autorole = valor;
    } else if (seccion === 'modlog') {
      c.modlog = valor;
    } else if (seccion === 'logs') {
      c.logs = valor;
    } else if (seccion === 'avisos') {
      c.avisosChannel = valor;
    } else if (seccion === 'niveles') {
      c.canalNiveles = valor;
    } else if (seccion === 'frases') {
      c.fraseDelDia = c.fraseDelDia || { canalId: null, hora: 12, frases: [], ultima: null };
      c.fraseDelDia.canalId = valor;
    } else if (seccion === 'staff') {
      c[`${campo}Role`] = valor;
    } else if (seccion === 'mute' && campo === 'rol') {
      c.muteRole = valor;
    } else if (seccion === 'escalada') {
      // Solo se guarda el valor crudo: utils/escalada.js valida y acota al leer,
      // así un valor viejo o raro nunca rompe /warn.
      c.escalada = { ...(c.escalada || {}), [campo]: valor };
    } else if (seccion === 'proteccion') {
      c.proteccion = { ...PROTECCION_DEFECTO, ...(c.proteccion || {}) };
      c.proteccion[campo] = valor;
    } else if (seccion === 'tickets') {
      c.tickets = c.tickets || {};
      c.tickets[campo === 'logs' ? 'canalLogs' : 'categoriaId'] = valor;
    }
  });
}

function aplicarDesactivado(guildId, feature) {
  setGuildConfig(guildId, (c) => {
    if (feature === 'bienvenida') {
      delete c.welcome;
      delete c.autorole;
    } else if (feature === 'modlog') delete c.modlog;
    else if (feature === 'logs') delete c.logs;
    else if (feature === 'avisos') delete c.avisosChannel;
    else if (feature === 'mute') delete c.muteRole;
    else if (feature === 'escalada') c.escalada = { ...(c.escalada || {}), activada: false };
    else if (feature === 'niveles') delete c.canalNiveles;
    else if (feature === 'frases') delete c.fraseDelDia;
    else if (feature === 'ia') c.iaActivada = false;
    else if (feature === 'proteccion') delete c.proteccion;
    else if (feature === 'servidores') delete c.servidores;
    else if (feature === 'tickets') delete c.tickets;
  });
}

// ---------- Router principal de componentes cfg:* ----------
async function manejarComponente(interaction) {
  const nivel = nivelStaff(interaction);
  if (!nivel) {
    return interaction.reply({
      embeds: [errorEmbed('Solo el staff puede usar el panel de configuración.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  const partes = interaction.customId.split(':'); // cfg:accion:...
  const accion = partes[1];
  const guild = interaction.guild;

  // Las secciones sensibles se revalidan en CADA componente, no solo al abrir el
  // panel: un helper que fabrique el customId no puede otorgarse roles de staff,
  // apagar la escalada ni desactivar las defensas del servidor.
  const seccion = seccionDeComponente(interaction);
  if (SECCIONES_SENSIBLES.has(seccion) && nivel !== 'admin') {
    return interaction.reply({
      embeds: [errorEmbed(`Solo un admin puede configurar **${NOMBRE_SECCION[seccion] ?? seccion}**.`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Select del menú principal: navegar a una sección
  if (accion === 'menu' && interaction.isStringSelectMenu()) {
    return interaction.update(vistaSeccion(interaction, interaction.values[0]));
  }

  // Botón volver al panel
  if (accion === 'volver') {
    return interaction.update(panelCompleto(interaction));
  }

  // Selectores de canal/rol: guardar y redibujar la sección
  if (accion === 'set' && interaction.isAnySelectMenu()) {
    const [, , seccionSet, campo] = partes;
    const valor = interaction.values[0];
    aplicarSet(guild.id, seccionSet, campo, valor);
    return interaction.update(vistaSeccion(interaction, seccionSet, true));
  }

  // Botón editar mensaje de bienvenida: abrir modal
  if (accion === 'msg' && interaction.isButton()) {
    const config = getGuildConfig(guild.id);
    const modal = new ModalBuilder()
      .setCustomId('cfg:modal:bienvenida')
      .setTitle('Mensaje de bienvenida')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('mensaje')
            .setLabel('Texto ({usuario} {servidor} {miembros})')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(config.welcome?.message || '¡Bienvenido {usuario} a **{servidor}**! Sos el miembro #{miembros}')
            .setMaxLength(1000)
            .setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }

  // Modal enviado: guardar mensaje y redibujar
  if (accion === 'modal' && partes[2] === 'bienvenida' && interaction.isModalSubmit()) {
    const texto = interaction.fields.getTextInputValue('mensaje');
    setGuildConfig(guild.id, (c) => {
      c.welcome = c.welcome || {};
      c.welcome.message = texto;
    });
    if (interaction.isFromMessage()) {
      return interaction.update(vistaSeccion(interaction, 'bienvenida', true));
    }
    return interaction.reply({
      embeds: [brandEmbed({ color: COLORS.success, title: 'Mensaje de bienvenida guardado' })],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Toggle de la IA
  if (accion === 'toggle' && partes[2] === 'ia' && interaction.isButton()) {
    const config = getGuildConfig(guild.id);
    const nuevo = config.iaActivada === false;
    setGuildConfig(guild.id, (c) => {
      c.iaActivada = nuevo;
    });
    return interaction.update(vistaSeccion(interaction, 'ia', true));
  }

  // Toggle de la escalada de advertencias
  if (accion === 'toggle' && partes[2] === 'escalada' && interaction.isButton()) {
    const actual = resolverEscalada(getGuildConfig(guild.id));
    setGuildConfig(guild.id, (c) => {
      c.escalada = { ...(c.escalada || {}), activada: !actual.activada };
    });
    return interaction.update(vistaSeccion(interaction, 'escalada', true));
  }

  // Botón que pide el modal de umbral y duración de la escalada
  if (accion === 'modalpedir' && partes[2] === 'escalada' && interaction.isButton()) {
    const e = resolverEscalada(getGuildConfig(guild.id));
    const modal = new ModalBuilder()
      .setCustomId('cfg:modal:escalada')
      .setTitle('Escalada de advertencias')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('umbral')
            .setLabel(`Advertencias para disparar (${LIMITES_ESCALADA.umbral[0]}-${LIMITES_ESCALADA.umbral[1]})`)
            .setStyle(TextInputStyle.Short)
            .setValue(String(e.umbral))
            .setMaxLength(2)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('duracion')
            .setLabel(`Duración en minutos (${LIMITES_ESCALADA.duracion[0]}-${LIMITES_ESCALADA.duracion[1]})`)
            .setStyle(TextInputStyle.Short)
            .setValue(String(e.duracion))
            .setMaxLength(5)
        )
      );
    return interaction.showModal(modal);
  }

  // Modal de escalada enviado: validar, guardar y redibujar
  if (accion === 'modal' && partes[2] === 'escalada' && interaction.isModalSubmit()) {
    const numero = (id, [min, max], defecto) => {
      const n = Number(interaction.fields.getTextInputValue(id));
      return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : defecto;
    };
    const base = resolverEscalada(getGuildConfig(guild.id));
    const umbral = numero('umbral', LIMITES_ESCALADA.umbral, base.umbral);
    const duracion = numero('duracion', LIMITES_ESCALADA.duracion, base.duracion);
    setGuildConfig(guild.id, (c) => {
      c.escalada = { ...(c.escalada || {}), umbral, duracion };
    });
    if (interaction.isFromMessage()) return interaction.update(vistaSeccion(interaction, 'escalada', true));
    return interaction.reply({
      embeds: [
        brandEmbed({
          color: COLORS.success,
          title: 'Escalada guardada',
          description: describirEscalada(resolverEscalada(getGuildConfig(guild.id))),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Toggle de un filtro del automod (cfg:toggle:proteccion:<clave>)
  if (accion === 'toggle' && partes[2] === 'proteccion' && partes[3] && interaction.isButton()) {
    const filtro = FILTROS_AUTOMOD.find((f) => f.clave === partes[3]);
    if (!filtro) return interaction.reply({ embeds: [errorEmbed('Ese filtro no existe.')], flags: MessageFlags.Ephemeral });
    const config = getGuildConfig(guild.id);
    const nuevo = config.proteccion?.[filtro.clave] !== true;
    setGuildConfig(guild.id, (c) => {
      c.proteccion = { ...PROTECCION_DEFECTO, ...(c.proteccion || {}) };
      c.proteccion[filtro.clave] = nuevo;
    });
    return interaction.update(vistaSeccion(interaction, 'proteccion', true));
  }

  // Toggle de la protección (anti-spam y anti-raid)
  if (accion === 'toggle' && partes[2] === 'proteccion' && !partes[3] && interaction.isButton()) {
    const config = getGuildConfig(guild.id);
    const nuevo = config.proteccion?.activado !== true;
    setGuildConfig(guild.id, (c) => {
      c.proteccion = { ...PROTECCION_DEFECTO, ...(c.proteccion || {}) };
      c.proteccion.activado = nuevo;
    });
    return interaction.update(vistaSeccion(interaction, 'proteccion', true));
  }

  // Toggle de la auto-acción en raids (por defecto solo alerta, por seguridad)
  if (accion === 'toggle' && partes[2] === 'raidAuto' && interaction.isButton()) {
    const config = getGuildConfig(guild.id);
    const nuevo = config.proteccion?.accionesRapidas !== true;
    setGuildConfig(guild.id, (c) => {
      c.proteccion = { ...PROTECCION_DEFECTO, ...(c.proteccion || {}) };
      c.proteccion.accionesRapidas = nuevo;
    });
    return interaction.update(vistaSeccion(interaction, 'proteccion', true));
  }

  // Botón que pide el modal de los parámetros del automod (cfg:modalpedir:proteccion:filtros)
  if (accion === 'modalpedir' && partes[2] === 'proteccion' && partes[3] === 'filtros' && interaction.isButton()) {
    const p = configProteccion(guild.id);
    const lim = (clave) => `${LIMITES_FILTROS[clave][0]}-${LIMITES_FILTROS[clave][1]}`;
    const modal = new ModalBuilder()
      .setCustomId('cfg:modal:proteccion:filtros')
      .setTitle('Parámetros del automod')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('mencionesMaximas')
            .setLabel(`Menciones por mensaje (${lim('mencionesMaximas')})`)
            .setStyle(TextInputStyle.Short)
            .setValue(String(p.mencionesMaximas))
            .setMaxLength(2)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('mayusculasPorcentaje')
            .setLabel(`Mayúsculas: % mínimo (${lim('mayusculasPorcentaje')})`)
            .setStyle(TextInputStyle.Short)
            .setValue(String(p.mayusculasPorcentaje))
            .setMaxLength(3)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('mayusculasMinimo')
            .setLabel(`Mayúsculas: letras mínimas (${lim('mayusculasMinimo')})`)
            .setStyle(TextInputStyle.Short)
            .setValue(String(p.mayusculasMinimo))
            .setMaxLength(2)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('repetidosVeces')
            .setLabel(`Repetidos: veces seguidas (${lim('repetidosVeces')})`)
            .setStyle(TextInputStyle.Short)
            .setValue(String(p.repetidosVeces))
            .setMaxLength(2)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('linksPermitidos')
            .setLabel('Enlaces permitidos (dominios separados por coma)')
            .setStyle(TextInputStyle.Short)
            .setValue(p.linksPermitidos.join(', '))
            .setMaxLength(300)
            .setRequired(false)
        )
      );
    return interaction.showModal(modal);
  }

  // Modal de parámetros del automod enviado: validar, guardar y redibujar
  if (accion === 'modal' && partes[2] === 'proteccion' && partes[3] === 'filtros' && interaction.isModalSubmit()) {
    const num = (id, clave, defecto) => {
      const n = Number(interaction.fields.getTextInputValue(id));
      return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), LIMITES_FILTROS[clave][0]), LIMITES_FILTROS[clave][1]) : defecto;
    };
    const base = configProteccion(guild.id);
    const mencionesMaximas = num('mencionesMaximas', 'mencionesMaximas', base.mencionesMaximas);
    const mayusculasPorcentaje = num('mayusculasPorcentaje', 'mayusculasPorcentaje', base.mayusculasPorcentaje);
    const mayusculasMinimo = num('mayusculasMinimo', 'mayusculasMinimo', base.mayusculasMinimo);
    const repetidosVeces = num('repetidosVeces', 'repetidosVeces', base.repetidosVeces);
    // La lista se escribe a mano: se acepta coma, espacio o punto y coma como separador.
    const linksPermitidos = normalizarDominios(
      String(interaction.fields.getTextInputValue('linksPermitidos') ?? '')
        .split(/[,;\s]+/)
        .filter(Boolean)
    );
    setGuildConfig(guild.id, (c) => {
      c.proteccion = { ...PROTECCION_DEFECTO, ...(c.proteccion || {}) };
      Object.assign(c.proteccion, { mencionesMaximas, mayusculasPorcentaje, mayusculasMinimo, repetidosVeces, linksPermitidos });
    });
    if (interaction.isFromMessage()) return interaction.update(vistaSeccion(interaction, 'proteccion', true));
    return interaction.reply({
      embeds: [brandEmbed({ color: COLORS.success, title: 'Parámetros del automod guardados' })],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Botón que pide el modal de umbrales de spam/raid
  if (accion === 'modalpedir' && partes[2] === 'proteccion' && interaction.isButton()) {
    const config = getGuildConfig(guild.id);
    const p = { ...PROTECCION_DEFECTO, ...(config.proteccion || {}) };
    const modal = new ModalBuilder()
      .setCustomId('cfg:modal:proteccion')
      .setTitle('Umbrales de spam y raid')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('spamMensajes')
            .setLabel('Spam: mensajes dentro de la ventana')
            .setStyle(TextInputStyle.Short)
            .setValue(String(p.spamMensajes))
            .setMaxLength(3)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('spamSegundos')
            .setLabel('Spam: ventana en segundos (2-120)')
            .setStyle(TextInputStyle.Short)
            .setValue(String(p.spamSegundos))
            .setMaxLength(3)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('raidJoins')
            .setLabel('Raid: ingresos para considerar oleada')
            .setStyle(TextInputStyle.Short)
            .setValue(String(p.raidJoins))
            .setMaxLength(3)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('raidSegundos')
            .setLabel('Raid: ventana en segundos (10-600)')
            .setStyle(TextInputStyle.Short)
            .setValue(String(p.raidSegundos))
            .setMaxLength(4)
        )
      );
    return interaction.showModal(modal);
  }

  // Modal de umbrales enviado: validar, guardar y redibujar
  if (accion === 'modal' && partes[2] === 'proteccion' && !partes[3] && interaction.isModalSubmit()) {
    const num = (id, min, max, defecto) => {
      const n = Number(interaction.fields.getTextInputValue(id));
      return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : defecto;
    };
    const spamMensajes = num('spamMensajes', 3, 20, PROTECCION_DEFECTO.spamMensajes);
    const spamSegundos = num('spamSegundos', 2, 120, PROTECCION_DEFECTO.spamSegundos);
    const raidJoins = num('raidJoins', 3, 50, PROTECCION_DEFECTO.raidJoins);
    const raidSegundos = num('raidSegundos', 10, 600, PROTECCION_DEFECTO.raidSegundos);
    setGuildConfig(guild.id, (c) => {
      c.proteccion = { ...PROTECCION_DEFECTO, ...(c.proteccion || {}) };
      Object.assign(c.proteccion, { spamMensajes, spamSegundos, raidJoins, raidSegundos });
    });
    if (interaction.isFromMessage()) return interaction.update(vistaSeccion(interaction, 'proteccion', true));
    return interaction.reply({
      embeds: [brandEmbed({ color: COLORS.success, title: 'Umbrales de protección guardados' })],
      flags: MessageFlags.Ephemeral,
    });
  }

  // ---------- Servidores CS 1.6 ----------
  // Botón que pide el modal de alta de server
  if (accion === 'modalpedir' && partes[2] === 'servidores' && interaction.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId('cfg:modal:servidores')
      .setTitle('Agregar servidor CS 1.6')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nombre')
            .setLabel('Nombre (ej: PÚBLICO CLÁSICO)')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(60)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ip')
            .setLabel('IP o dominio con puerto (host:puerto)')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setPlaceholder('cs.nostalgia.ar:27015')
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('modo')
            .setLabel('Modo (opcional: Público, KZ, AutoMix…)')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(40)
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('descripcion')
            .setLabel('Descripción para la ficha (opcional)')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(300)
            .setPlaceholder('Modo clásico competitivo con equipos de 5 contra 5…')
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('imagen')
            .setLabel('URL de imagen de la ficha (opcional, ej: mapa)')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(300)
            .setPlaceholder('https://…/dust2.jpg')
            .setRequired(false)
        )
      );
    return interaction.showModal(modal);
  }

  // Modal de alta enviado: validar IP y guardar
  if (accion === 'modal' && partes[2] === 'servidores' && interaction.isModalSubmit()) {
    const nombre = interaction.fields.getTextInputValue('nombre').trim();
    const ipCruda = interaction.fields.getTextInputValue('ip').trim();
    const modo = (interaction.fields.getTextInputValue('modo') || '').trim();
    const descripcion = (interaction.fields.getTextInputValue('descripcion') || '').trim();
    const imagen = (interaction.fields.getTextInputValue('imagen') || '').trim();
    const [hostCrudo, puertoCrudo] = ipCruda.split(':');
    const host = hostCrudo.trim();
    const puerto = Number(puertoCrudo) || 27015;

    if (!host || !/^[\w.-]+$/.test(host)) {
      return interaction.reply({
        embeds: [errorEmbed('La IP no parece válida. Usá `host:puerto`, por ejemplo `cs.nostalgia.ar:27015`.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    setGuildConfig(guild.id, (c) => {
      c.servidores = c.servidores || {};
      c.servidores.lista = c.servidores.lista || [];
      c.servidores.lista.push({ nombre, host, puerto, modo, descripcion, imagen: imagen || undefined });
    });
    if (interaction.isFromMessage()) return interaction.update(vistaSeccion(interaction, 'servidores', true));
    return interaction.reply({
      embeds: [brandEmbed({ color: COLORS.success, title: `Servidor "${nombre}" agregado`, description: `Ya podés usar /servidores e /ip.` })],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Quitar un server del listado
  if (accion === 'servers' && partes[2] === 'quitar' && interaction.isStringSelectMenu()) {
    const indice = Number(interaction.values[0]);
    setGuildConfig(guild.id, (c) => {
      if (c.servidores?.lista?.[indice]) c.servidores.lista.splice(indice, 1);
    });
    return interaction.update(vistaSeccion(interaction, 'servidores', true));
  }

  // Toggle de alertas de caída/vuelta
  if (accion === 'toggle' && partes[2] === 'servMonitoreo' && interaction.isButton()) {
    setGuildConfig(guild.id, (c) => {
      c.servidores = c.servidores || {};
      c.servidores.monitoreo = c.servidores.monitoreo === false ? true : false;
    });
    return interaction.update(vistaSeccion(interaction, 'servidores', true));
  }

  // Olvidar el panel publicado (por si lo borraron a mano)
  if (accion === 'servers' && partes[2] === 'limpiarPanel' && interaction.isButton()) {
    setGuildConfig(guild.id, (c) => {
      if (c.servidores) {
        delete c.servidores.canalPanel;
        delete c.servidores.mensajePanel;
      }
    });
    return interaction.update(vistaSeccion(interaction, 'servidores', true));
  }

  // Desactivar: pedir confirmación
  if (accion === 'off' && partes[2] === 'ask' && interaction.isButton()) {
    return interaction.update(vistaConfirmarDesactivado(partes[3]));
  }

  // Desactivar: elegir desde el menú de la sección desactivar
  if (accion === 'off' && partes[2] === 'menu' && interaction.isStringSelectMenu()) {
    return interaction.update(vistaConfirmarDesactivado(interaction.values[0]));
  }

  // Desactivar: confirmado
  if (accion === 'off' && partes[2] === 'si' && interaction.isButton()) {
    const feature = partes[3];
    aplicarDesactivado(guild.id, feature);
    return interaction.update(vistaSeccion(interaction, feature, true));
  }

  // Cualquier otra cosa: limpiar componentes para no dejar botones muertos
  return interaction.update({ components: [] });
}

module.exports = {
  panelCompleto,
  filaMenuPrincipal,
  vistaSeccion,
  manejarComponente,
  nivelStaff,
  esStaff,
  seccionDeComponente,
  SECCIONES_SENSIBLES,
};
