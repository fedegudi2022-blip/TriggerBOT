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
  PermissionFlagsBits,
} = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { brandEmbed, errorEmbed } = require('./replies');
const { POR_DEFECTO: PROTECCION_DEFECTO } = require('./proteccion');

// ---------- Definición de secciones ----------
const SECCIONES = [
  { value: 'bienvenida', label: 'Bienvenida y autorol', description: 'Canal, mensaje y rol automático para nuevos miembros', emoji: '1️⃣' },
  { value: 'modlog', label: 'Mod-log', description: 'Canal de registro de acciones de moderación', emoji: '2️⃣' },
  { value: 'logs', label: 'Logs de eventos', description: 'Mensajes borrados/editados, salidas, roles y apodos', emoji: '3️⃣' },
  { value: 'avisos', label: 'Avisos al staff', description: 'Canal de notificaciones para el equipo', emoji: '4️⃣' },
  { value: 'staff', label: 'Roles de staff', description: 'Quiénes son admin, mod y helper para el bot', emoji: '5️⃣' },
  { value: 'mute', label: 'Rol de silenciado', description: 'Rol que usa /mute (si no hay, se crea uno solo)', emoji: '6️⃣' },
  { value: 'ia', label: 'Chat con IA', description: 'Prender o apagar las respuestas al mencionar al bot', emoji: '7️⃣' },
  { value: 'niveles', label: 'Niveles y XP', description: 'Canal donde se anuncian subidas de nivel y logros', emoji: '8️⃣' },
  { value: 'frases', label: 'Frase del día', description: 'Canal y hora de la frase automática diaria', emoji: '9️⃣' },
  { value: 'proteccion', label: 'Anti-spam y anti-raid', description: 'Flood y oleadas de ingresos con acción automática', emoji: '🛡️' },
  { value: 'desactivar', label: 'Desactivar funciones', description: 'Apagar funciones que ya no querés usar', emoji: '🔟' },
];

const NOMBRE_SECCION = Object.fromEntries(SECCIONES.map((s) => [s.value, s.label]));

// ---------- Helpers de filas ----------
function filaMenuPrincipal() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cfg:menu')
      .setPlaceholder('Elegí qué querés configurar')
      .addOptions(SECCIONES.map((s) => ({ label: s.label, value: s.value, description: s.description, emoji: s.emoji })))
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
function panelCompleto(guild) {
  const config = getGuildConfig(guild.id);

  const estado = (v) => (v ? v : '*sin configurar*');
  const staffLines = ['admin', 'mod', 'helper']
    .map((nivel) => {
      const nombres = { admin: 'Admin', mod: 'Mod', helper: 'Helper' };
      return `• ${nombres[nivel]}: ${rolActual(config[`${nivel}Role`])}`;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Configuración del servidor')
    .setColor(0x5865f2)
    .setDescription('Usá el menú de abajo para configurar cada sección. Todo se guarda al instante.')
    .addFields(
      { name: 'Bienvenida', value: estado(config.welcome?.channelId ? `<#${config.welcome.channelId}>` : null), inline: true },
      { name: 'Autorol', value: estado(config.autorole ? `<@&${config.autorole}>` : null), inline: true },
      { name: 'Mod-log', value: estado(config.modlog ? `<#${config.modlog}>` : null), inline: true },
      { name: 'Logs', value: estado(config.logs ? `<#${config.logs}>` : null), inline: true },
      { name: 'Avisos al staff', value: estado(config.avisosChannel ? `<#${config.avisosChannel}>` : null), inline: true },
      { name: 'Rol de silenciado', value: estado(config.muteRole ? `<@&${config.muteRole}>` : null), inline: true },
      { name: 'Chat con IA', value: config.iaActivada === false ? 'Apagada' : 'Prendida', inline: true },
      { name: 'Anti-spam/raid', value: config.proteccion?.activado ? 'Prendida' : 'Apagada', inline: true },
      { name: 'Canal de niveles', value: estado(config.canalNiveles ? `<#${config.canalNiveles}>` : null), inline: true },
      { name: 'Frase del día', value: estado(config.fraseDelDia?.canalId ? `<#${config.fraseDelDia.canalId}>` : null), inline: true },
      { name: 'Staff del bot', value: staffLines, inline: false }
    )
    .setFooter({ text: 'TriggerBOT' })
    .setTimestamp();

  return { embeds: [embed], components: [filaMenuPrincipal()] };
}

// ---------- Vistas por sección ----------
function vistaSeccion(guild, seccion, guardado = false) {
  const config = getGuildConfig(guild.id);
  const nota = guardado ? '\n\n**Guardado.**' : '';
  const components = [];
  let embed;
  // Valores de la sección de protección (completados con los por defecto).
  const p = { ...PROTECCION_DEFECTO, ...(config.proteccion || {}) };

  if (seccion === 'bienvenida') {
    embed = new EmbedBuilder()
      .setTitle('Bienvenida y autorol')
      .setColor(0x5865f2)
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
      logs: { titulo: 'Logs de eventos', actual: canalActual(config.logs), desc: 'Mensajes borrados/editados, salidas, roles y apodos. Si no hay, usa el mod-log.' },
      avisos: { titulo: 'Avisos al staff', actual: canalActual(config.avisosChannel), desc: 'Notificaciones para el equipo de moderación.' },
    }[seccion];

    embed = new EmbedBuilder()
      .setTitle(datos.titulo)
      .setColor(0x5865f2)
      .setDescription(`**Canal actual:** ${datos.actual}\n\n${datos.desc}${nota}`);

    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`cfg:set:${seccion}:canal`)
          .setPlaceholder('Elegí el canal')
          .setChannelTypes(ChannelType.GuildText)
      )
    );
    components.push(new ActionRowBuilder().addComponents(filaDesactivar(seccion).components[0], filaVolver().components[0]));
  } else if (seccion === 'staff') {
    embed = new EmbedBuilder()
      .setTitle('Roles de staff')
      .setColor(0x5865f2)
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
        new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder().setCustomId(`cfg:set:staff:${nivel}`).setPlaceholder(placeholder)
        )
      );
    }
    components.push(filaVolver());
  } else if (seccion === 'mute') {
    embed = new EmbedBuilder()
      .setTitle('Rol de silenciado')
      .setColor(0x5865f2)
      .setDescription(
        `**Rol actual:** ${rolActual(config.muteRole)}${nota}\n\n` +
          'Si no configurás ninguno, /mute crea y configura uno llamado "Silenciado" automáticamente.'
      );

    components.push(
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId('cfg:set:mute:rol').setPlaceholder('Elegí el rol de silenciado')
      )
    );
    components.push(new ActionRowBuilder().addComponents(filaDesactivar('mute').components[0], filaVolver().components[0]));
  } else if (seccion === 'ia') {
    const prendida = config.iaActivada !== false;
    embed = new EmbedBuilder()
      .setTitle('Chat con IA')
      .setColor(0x5865f2)
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
      .setColor(0x5865f2)
      .setDescription(`**Canal actual:** ${canalActual(canalId)}\n\n${extra}${nota}`);

    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`cfg:set:${seccion}:canal`)
          .setPlaceholder('Elegí el canal')
          .setChannelTypes(ChannelType.GuildText)
      )
    );
    components.push(new ActionRowBuilder().addComponents(filaDesactivar(seccion).components[0], filaVolver().components[0]));
  } else if (seccion === 'proteccion') {
    const { ETIQUETA_ACCION_SPAM, ETIQUETA_ACCION_RAID } = require('./proteccion');
    const OPCIONES_SPAM = [
      { valor: 'aviso', etiqueta: 'Borrar mensajes', emoji: '🧹' },
      { valor: 'timeout', etiqueta: 'Timeout 10 min', emoji: '⏱️' },
      { valor: 'mute', etiqueta: 'Silenciar con rol', emoji: '🔇' },
      { valor: 'kick', etiqueta: 'Expulsar', emoji: '👋' },
      { valor: 'ban', etiqueta: 'Banear', emoji: '🔨' },
    ];
    const OPCIONES_RAID = [
      { valor: 'nada', etiqueta: 'Solo alertar', emoji: '🔔' },
      { valor: 'kick', etiqueta: 'Expulsar', emoji: '👋' },
      { valor: 'ban', etiqueta: 'Banear', emoji: '🔨' },
    ];

    embed = new EmbedBuilder()
      .setTitle('Anti-spam y anti-raid')
      .setColor(0x5865f2)
      .setDescription(
        `**Estado:** ${p.activado ? '🟢 Prendida' : '🔴 Apagada'}${nota}\n\n` +
          `**Spam:** ${p.spamMensajes} mensajes en ${p.spamSegundos} s → **${ETIQUETA_ACCION_SPAM[p.accionSpam] ?? p.accionSpam}**\n` +
          `**Raid:** ${p.raidJoins} ingresos en ${p.raidSegundos} s → **${ETIQUETA_ACCION_RAID[p.accionRaid] ?? p.accionRaid}**\n` +
          `**Auto-acción en raids:** ${p.accionesRapidas ? 'Prendida (actúa sola sobre cuentas nuevas sin roles)' : 'Apagada (solo alerta)'}\n\n` +
          'El staff con permiso de gestionar mensajes está exento del anti-spam. Las alertas van al canal de avisos (o logs/mod-log si no hay).'
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
          .addOptions(OPCIONES_SPAM.map((o) => ({ label: o.etiqueta, value: o.valor, emoji: o.emoji, default: p.accionSpam === o.valor })))
      )
    );
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:set:proteccion:accionRaid')
          .setPlaceholder('Acción ante oleada de ingresos')
          .addOptions(OPCIONES_RAID.map((o) => ({ label: o.etiqueta, value: o.valor, emoji: o.emoji, default: p.accionRaid === o.valor })))
      )
    );
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:modalpedir:proteccion').setLabel('Ajustar umbrales').setStyle(ButtonStyle.Primary),
        filaVolver().components[0]
      )
    );
  } else if (seccion === 'desactivar') {
    embed = new EmbedBuilder()
      .setTitle('Desactivar funciones')
      .setColor(0x5865f2)
      .setDescription('Elegí la función que querés apagar. Te va a pedir confirmación.');

    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:off:menu')
          .setPlaceholder('Elegí la función a desactivar')
          .addOptions(
            SECCIONES.filter((s) => s.value !== 'desactivar').map((s) => ({
              label: s.label,
              value: s.value,
              emoji: s.emoji,
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
    .setColor(0xfee75c)
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

// ---------- Permisos ----------
function esStaff(interaction) {
  if (interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const config = getGuildConfig(interaction.guildId);
  return ['admin', 'mod', 'helper'].some((nivel) => interaction.member.roles.cache.has(config[`${nivel}Role`]));
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
    } else if (seccion === 'proteccion') {
      c.proteccion = { ...PROTECCION_DEFECTO, ...(c.proteccion || {}) };
      c.proteccion[campo] = valor;
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
    else if (feature === 'niveles') delete c.canalNiveles;
    else if (feature === 'frases') delete c.fraseDelDia;
    else if (feature === 'ia') c.iaActivada = false;
    else if (feature === 'proteccion') delete c.proteccion;
  });
}

// ---------- Router principal de componentes cfg:* ----------
async function manejarComponente(interaction) {
  if (!esStaff(interaction)) {
    return interaction.reply({
      embeds: [errorEmbed('Solo el staff puede usar el panel de configuración.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  const partes = interaction.customId.split(':'); // cfg:accion:...
  const accion = partes[1];
  const guild = interaction.guild;

  // Select del menú principal: navegar a una sección
  if (accion === 'menu' && interaction.isStringSelectMenu()) {
    return interaction.update(vistaSeccion(guild, interaction.values[0]));
  }

  // Botón volver al panel
  if (accion === 'volver') {
    return interaction.update(panelCompleto(guild));
  }

  // Selectores de canal/rol: guardar y redibujar la sección
  if (accion === 'set' && interaction.isAnySelectMenu()) {
    const [, , seccion, campo] = partes;
    const valor = interaction.values[0];
    aplicarSet(guild.id, seccion, campo, valor);
    return interaction.update(vistaSeccion(guild, seccion, true));
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
      return interaction.update(vistaSeccion(guild, 'bienvenida', true));
    }
    return interaction.reply({ embeds: [brandEmbed({ color: 0x57f287, title: 'Mensaje de bienvenida guardado' })], flags: MessageFlags.Ephemeral });
  }

  // Toggle de la IA
  if (accion === 'toggle' && partes[2] === 'ia' && interaction.isButton()) {
    const config = getGuildConfig(guild.id);
    const nuevo = config.iaActivada === false;
    setGuildConfig(guild.id, (c) => {
      c.iaActivada = nuevo;
    });
    return interaction.update(vistaSeccion(guild, 'ia', true));
  }

  // Toggle de la protección (anti-spam y anti-raid)
  if (accion === 'toggle' && partes[2] === 'proteccion' && interaction.isButton()) {
    const config = getGuildConfig(guild.id);
    const nuevo = config.proteccion?.activado !== true;
    setGuildConfig(guild.id, (c) => {
      c.proteccion = { ...PROTECCION_DEFECTO, ...(c.proteccion || {}) };
      c.proteccion.activado = nuevo;
    });
    return interaction.update(vistaSeccion(guild, 'proteccion', true));
  }

  // Toggle de la auto-acción en raids (por defecto solo alerta, por seguridad)
  if (accion === 'toggle' && partes[2] === 'raidAuto' && interaction.isButton()) {
    const config = getGuildConfig(guild.id);
    const nuevo = config.proteccion?.accionesRapidas !== true;
    setGuildConfig(guild.id, (c) => {
      c.proteccion = { ...PROTECCION_DEFECTO, ...(c.proteccion || {}) };
      c.proteccion.accionesRapidas = nuevo;
    });
    return interaction.update(vistaSeccion(guild, 'proteccion', true));
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
  if (accion === 'modal' && partes[2] === 'proteccion' && interaction.isModalSubmit()) {
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
    if (interaction.isFromMessage()) return interaction.update(vistaSeccion(guild, 'proteccion', true));
    return interaction.reply({
      embeds: [brandEmbed({ color: 0x57f287, title: 'Umbrales de protección guardados' })],
      flags: MessageFlags.Ephemeral,
    });
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
    return interaction.update(vistaSeccion(guild, feature, true));
  }

  // Cualquier otra cosa: limpiar componentes para no dejar botones muertos
  return interaction.update({ components: [] });
}

module.exports = { panelCompleto, filaMenuPrincipal, vistaSeccion, manejarComponente };
