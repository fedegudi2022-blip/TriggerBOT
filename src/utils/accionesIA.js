const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('./modlog');
const { successEmbed, errorEmbed, brandEmbed, COLORS } = require('./replies');
const { validarAccionDelBot } = require('./moderation');
const { LIMITE_14_DIAS_MS } = require('./acciones');
const { getGuildConfig } = require('../store');

const LABELS = {
  warn: { titulo: '⚠️ Advertencia', verbo: 'advertir' },
  timeout: { titulo: '🔇 Silencio temporal', verbo: 'silenciar' },
  mute: { titulo: '🔇 Silencio (rol)', verbo: 'mutear' },
  kick: { titulo: '👢 Expulsión', verbo: 'expulsar' },
  ban: { titulo: '🔨 Baneo', verbo: 'banear' },
  limpiar: { titulo: '🧹 Limpieza del canal', verbo: 'borrar mensajes de este canal' },
  slowmode: { titulo: '⏱️ Modo lento', verbo: 'poner modo lento en este canal' },
  bloquear: { titulo: '🔒 Bloqueo del canal', verbo: 'cerrar este canal' },
  desbloquear: { titulo: '🔓 Desbloqueo del canal', verbo: 'abrir este canal' },
};

// Las órdenes por chat son de dos familias:
//   · PERSONA: llevan un objetivo, que hay que resolver y validar (dueño, jerarquía, bot).
//   · CANAL: actúan sobre el canal donde se dio la orden — lo mismo que /clear, /slowmode
//     y /lockdown— y no llevan objetivo.
const ACCIONES_PERSONA = ['warn', 'timeout', 'mute', 'kick', 'ban'];
const ACCIONES_CANAL = ['limpiar', 'slowmode', 'bloquear', 'desbloquear'];
const ACCIONES = [...ACCIONES_PERSONA, ...ACCIONES_CANAL];

// Permiso concreto que el BOT necesita para cada acción sobre una persona.
const PERMISO_ACCION = {
  warn: PermissionFlagsBits.ModerateMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  mute: PermissionFlagsBits.ManageRoles,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
};

// Permiso que el bot necesita SOBRE EL CANAL para ejecutar la orden.
const PERMISO_BOT_CANAL = {
  limpiar: PermissionFlagsBits.ManageMessages,
  slowmode: PermissionFlagsBits.ManageChannels,
  bloquear: PermissionFlagsBits.ManageChannels,
  desbloquear: PermissionFlagsBits.ManageChannels,
};

// Permiso que necesita QUIEN CONFIRMA: el mismo que exige el comando equivalente
// (/clear → Gestionar mensajes; /slowmode y /lockdown → Gestionar canales). Así, por
// chat, la barra es exactamente la misma que por comando.
const PERMISO_CONFIRMAR = {
  limpiar: PermissionFlagsBits.ManageMessages,
  slowmode: PermissionFlagsBits.ManageChannels,
  bloquear: PermissionFlagsBits.ManageChannels,
  desbloquear: PermissionFlagsBits.ManageChannels,
};

const MAX_BORRADO = 100; // tope de Discord por llamada a bulkDelete
const MAX_SLOWMODE_SEG = 21600; // 6 h: máximo que acepta Discord

function acotar(valor, min, max, porDefecto) {
  const n = Math.round(Number(valor));
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(Math.max(n, min), max);
}

// ¿Esta persona puede pedir/confirmar esta orden? Lo usan los DOS momentos: pedir la
// acción por chat y apretar el botón.
//
// Regla: el dueño y el staff de /config (roles admin/mod/helper, la definición de staff
// de ESTE servidor) pueden todo; para cualquier otro vale el permiso EXACTO que exige el
// comando equivalente — moderar miembros para las acciones sobre personas, Gestionar
// mensajes para /clear y Gestionar canales para /slowmode/\`lockdown\`. Así por chat nadie
// puede hacer algo que por comando no podría.
function puedeConfirmar(interaction, accion) {
  const member = interaction.member;
  const usuario = interaction.user ?? interaction.author;
  if (!member || !usuario) return false;
  if (interaction.guild.ownerId === usuario.id) return true;

  const config = getGuildConfig(interaction.guild.id);
  if (['admin', 'mod', 'helper'].some((nivel) => member.roles?.cache?.has?.(config[`${nivel}Role`]))) return true;

  const permiso = PERMISO_CONFIRMAR[accion] ?? PermissionFlagsBits.ModerateMembers;
  return Boolean(member.permissions?.has?.(permiso));
}

const COOLDOWN_MS = 20_000;
const cooldowns = new Map(); // solicitanteId → timestamp del último pedido

// Acciones pendientes de confirmación: messageId → datos completos.
// Más robusto que parsear el embed al apretar el botón.
const pendientes = new Map();

// Limpieza periódica: las solicitudes vencen a los 5 minutos.
setInterval(() => {
  const ahora = Date.now();
  for (const [messageId, datos] of pendientes) {
    if (ahora - datos.creada > 5 * 60 * 1000) pendientes.delete(messageId);
  }
}, 60 * 1000).unref();

// MISMAS validaciones que moderation.js aplica a los comandos normales, pero
// pensadas para acciones iniciadas por IA (el "moderador" es quien confirma).
// Devuelve un mensaje de error o null si todo está bien.
function validarAccionIA(accion, interaction, miembro) {
  const guild = interaction.guild;

  // 1) El objetivo no puede ser el dueño del servidor.
  if (miembro.id === guild.ownerId) return 'El objetivo es el dueño del servidor: no se puede moderar.';

  // 2) El objetivo no puede ser el propio bot.
  if (miembro.id === interaction.client.user.id) return 'El objetivo es el propio bot.';

  // 3) Jerarquía respecto de quien confirma: sin rol igual o superior (salvo que sea el dueño).
  const esDuenoModerador = guild.ownerId === interaction.user.id;
  if (!esDuenoModerador && miembro.roles.highest.position >= interaction.member.roles.highest.position) {
    return 'Tu rol más alto está por debajo o al mismo nivel del de ese usuario.';
  }

  // 4) El bot debe poder moderar al objetivo y tener el permiso concreto necesario.
  //    (mute sin rol configurado cae a timeout, así que también exige ModerateMembers.)
  const permiso = PERMISO_ACCION[accion];
  const error = validarAccionDelBot(guild, miembro, permiso);
  if (error) return `El bot no puede ejecutar la acción: ${error}`;
  if (accion === 'mute' && !guild.roles.cache.get(require('../store').getGuildConfig(guild.id).muteRole)) {
    const errorTimeout = validarAccionDelBot(guild, miembro, PermissionFlagsBits.ModerateMembers);
    if (errorTimeout) return `Sin rol de silenciado y ${errorTimeout.toLowerCase()}`;
  }

  return null;
}

// Validaciones de una orden sobre el CANAL: tiene que ser de texto, el bot tiene que
// poder gestionarlo y tener el permiso puntual (borrar mensajes / gestionar el canal).
// Devuelve un mensaje de error o null si todo está bien.
function validarAccionCanal(accion, interaction, canal) {
  if (!canal) return 'No encontré el canal donde se pidió la acción.';
  if (canal.isTextBased?.() === false) return `No puedo hacer eso en <#${canal.id}>: no es un canal de texto.`;
  if (accion === 'limpiar' && !canal.messages) return `No puedo leer los mensajes de <#${canal.id}>.`;

  const permiso = PERMISO_BOT_CANAL[accion];
  const permisos = canal.permissionsFor?.(interaction.guild.members?.me);
  if (permisos && permiso && !permisos.has(permiso)) {
    const falta = accion === 'limpiar' ? 'Gestionar mensajes' : 'Gestionar canales';
    return `Me falta el permiso de **${falta}** en <#${canal.id}>.`;
  }
  return null;
}

// Ejecuta la acción de moderación ya confirmada. Devuelve el texto de resultado.
// Lanza solo si la acción es desconocida; los fallos de Discord se reportan tal cual.
async function ejecutarAccion(interaction, accion, miembro, motivo, duracionMin) {
  const guild = interaction.guild;
  const etiqueta = `<@${miembro.id}>`;

  if (accion === 'warn') {
    const { addWarn } = require('../warns');
    const total = addWarn(guild.id, miembro.id, {
      reason: motivo || 'Solicitud por chat con IA',
      moderatorId: interaction.user.id,
      timestamp: Date.now(),
    });
    let escalado = '';
    if (total >= 3 && miembro.moderatable) {
      const ok = await miembro
        .timeout(60 * 60 * 1000, `Acumuló ${total} advertencias — por ${interaction.user.tag}`)
        .then(() => true)
        .catch(() => false);
      escalado = ok ? ' Quedó silenciado 1 hora por llegar a 3.' : ' (El timeout automático por acumulación fue rechazado por Discord.)';
    }
    logAction(guild, {
      action: 'Advertencia (warn)',
      color: COLORS.warn,
      target: miembro.user,
      moderator: interaction.user,
      reason: motivo,
      extra: `Solicitada por chat con IA. Total: ${total} advertencia(s).`,
    });
    return `⚠️ ${etiqueta} fue advertido (${total} advertencia(s) en total).${escalado}`;
  }

  if (accion === 'timeout') {
    const minutos = Math.min(Math.max(duracionMin || 60, 5), 28 * 24 * 60); // 5 min a 28 días
    try {
      await miembro.timeout(minutos * 60 * 1000, `${motivo || 'Solicitud por chat con IA'} — por ${interaction.user.tag}`);
    } catch (error) {
      throw new Error(`Discord rechazó el timeout: ${error.message}`);
    }
    logAction(guild, {
      action: 'Silencio (timeout)',
      target: miembro.user,
      moderator: interaction.user,
      reason: motivo,
      duration: `${minutos} min`,
      extra: 'Solicitada por chat con IA.',
    });
    return `🔇 ${etiqueta} quedó silenciado por **${minutos} minutos**.`;
  }

  if (accion === 'mute') {
    const { asegurarRolMute } = require('../commands/mute');
    let rol;
    try {
      rol = await asegurarRolMute(guild);
    } catch (error) {
      throw new Error(`No pude preparar el rol Silenciado (¿tengo permiso de Gestionar roles?): ${error.message}`);
    }
    try {
      await miembro.roles.add(rol, `${motivo || 'Solicitud por chat con IA'} — por ${interaction.user.tag}`);
    } catch (error) {
      throw new Error(`Discord rechazó asignar el rol de silenciado: ${error.message}`);
    }
    logAction(guild, {
      action: 'Silencio (mute)',
      target: miembro.user,
      moderator: interaction.user,
      reason: motivo,
      duration: 'Indefinido',
      extra: 'Solicitada por chat con IA.',
    });
    return `🔇 ${etiqueta} quedó muteado (rol Silenciado).`;
  }

  if (accion === 'kick') {
    try {
      await miembro.kick(`${motivo || 'Solicitud por chat con IA'} — por ${interaction.user.tag}`);
    } catch (error) {
      throw new Error(`Discord rechazó la expulsión: ${error.message}`);
    }
    logAction(guild, {
      action: 'Expulsión (kick)',
      target: miembro.user,
      moderator: interaction.user,
      reason: motivo,
      extra: 'Solicitada por chat con IA.',
    });
    return `👢 ${etiqueta} fue expulsado.`;
  }

  if (accion === 'ban') {
    try {
      await guild.members.ban(miembro.id, {
        reason: `${motivo || 'Solicitud por chat con IA'} — por ${interaction.user.tag}`,
      });
    } catch (error) {
      throw new Error(`Discord rechazó el baneo: ${error.message}`);
    }
    logAction(guild, {
      action: 'Baneo (ban)',
      target: miembro.user,
      moderator: interaction.user,
      reason: motivo,
      extra: 'Solicitada por chat con IA.',
    });
    return `🔨 ${etiqueta} fue baneado.`;
  }

  throw new Error(`Acción desconocida: ${accion}`);
}

// Ejecuta una orden sobre el canal ya confirmada. Mismas reglas que los comandos:
// no más de 100 mensajes por vez, nada de más de 14 días en bloque, y 0-6 h de modo
// lento. Cada caso queda en el mod-log con el mismo nombre que usa el comando.
async function ejecutarAccionCanal(interaction, datos, canal) {
  const guild = interaction.guild;
  const motivo = datos.motivo;
  const firma = (accion) => `${motivo || 'Orden por chat'} — ${accion} por ${interaction.user.tag} · pedido por chat con IA`;
  const canalTexto = `Canal ${canal} (\`#${canal.name}\`)`;

  if (datos.accion === 'limpiar') {
    const cantidad = acotar(datos.cantidad, 1, MAX_BORRADO, MAX_BORRADO);
    const mensajes = await canal.messages.fetch({ limit: cantidad }).catch(() => null);
    if (!mensajes) throw new Error('No pude leer los mensajes del canal (¿me falta permiso de Leer historial?)');

    const frescos = [...mensajes.values()].filter((m) => Date.now() - m.createdTimestamp < LIMITE_14_DIAS_MS);
    const viejos = mensajes.size - frescos.length;
    if (!frescos.length) {
      throw new Error(
        viejos
          ? `Los **${viejos}** mensaje(s) que encontré tienen más de 14 días: Discord no permite borrarlos en bloque.`
          : 'No encontré mensajes para borrar en este canal.'
      );
    }

    let borrados = 0;
    if (frescos.length === 1) {
      await frescos[0].delete();
      borrados = 1;
    } else {
      const resultado = await canal.bulkDelete(frescos, true);
      borrados = resultado.size;
    }

    logAction(guild, {
      action: 'Borrado masivo (clear)',
      color: COLORS.warn,
      target: { raw: canalTexto },
      moderator: interaction.user,
      reason: motivo,
      extra:
        `Canal: <#${canal.id}> — ${borrados} mensaje(s)` +
        (viejos ? ` · ${viejos} con más de 14 días quedaron afuera` : '') +
        ' · pedido por chat con IA',
    });
    return `🧹 Borré **${borrados}** mensaje(s) de <#${canal.id}>.` + (viejos ? ` ${viejos} tenían más de 14 días y quedaron afuera.` : '');
  }

  if (datos.accion === 'slowmode') {
    const segundos = acotar(datos.segundos, 0, MAX_SLOWMODE_SEG, 0);
    try {
      await canal.setRateLimitPerUser(segundos, firma('slowmode'));
    } catch (error) {
      throw new Error(`Discord rechazó el cambio de modo lento: ${error.message}`);
    }
    logAction(guild, {
      action: 'Modo lento (slowmode)',
      color: COLORS.info,
      target: { raw: canalTexto },
      moderator: interaction.user,
      reason: motivo,
      extra: `Canal: <#${canal.id}> — ${segundos === 0 ? 'desactivado' : `${segundos}s de espera`} · pedido por chat con IA`,
    });
    return segundos === 0 ? `⏱️ Modo lento **desactivado** en <#${canal.id}>.` : `⏱️ Modo lento de **${segundos}s** activado en <#${canal.id}>.`;
  }

  const bloquear = datos.accion === 'bloquear';
  try {
    await canal.permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: bloquear ? false : null },
      firma(bloquear ? 'lockdown' : 'desbloqueo')
    );
  } catch (error) {
    throw new Error(`Discord rechazó ${bloquear ? 'el bloqueo' : 'el desbloqueo'}: ${error.message}`);
  }
  logAction(guild, {
    action: bloquear ? 'Bloqueo de canal (lockdown)' : 'Desbloqueo de canal',
    color: bloquear ? COLORS.error : COLORS.success,
    target: { raw: canalTexto },
    moderator: interaction.user,
    reason: motivo,
    extra: `Canal: <#${canal.id}> · pedido por chat con IA`,
  });
  return bloquear
    ? `🔒 <#${canal.id}> quedó cerrado: nadie de @everyone puede escribir hasta que lo abran.`
    : `🔓 <#${canal.id}> quedó abierto: ya se puede volver a escribir.`;
}

// Muestra el pedido de la IA con botones de confirmación (solo staff puede tocar).
async function pedirConfirmacion(message, solicitud) {
  // Anti-abuso: un mismo usuario no puede disparar confirmaciones sin pausa.
  const ultima = cooldowns.get(message.author.id) ?? 0;
  if (Date.now() - ultima < COOLDOWN_MS) {
    await message.reply('Tenés que esperar un poco antes de pedir otra acción de moderación por chat.');
    return;
  }

  // Órdenes sobre el canal: no hay objetivo que resolver y solo el staff puede pedirlas
  // (afectan a todos los que están ahí, no a una persona que el que pide eligió).
  if (ACCIONES_CANAL.includes(solicitud.accion)) {
    if (!puedeConfirmar(message, solicitud.accion)) {
      await message.reply({
        embeds: [
          errorEmbed(
            'Solo el staff puede pedir esa acción sobre el canal. Si necesitás una limpieza o cerrar el canal, pedíselo a un moderador.',
            'Sin permiso'
          ),
        ],
      });
      return;
    }

    const label = LABELS[solicitud.accion];
    const detalles = [];
    if (solicitud.accion === 'limpiar') {
      detalles.push(
        `**Mensajes:** hasta ${acotar(solicitud.cantidad, 1, MAX_BORRADO, MAX_BORRADO)} de <#${message.channel.id}> (los de más de 14 días no se pueden borrar en bloque)`
      );
    }
    if (solicitud.accion === 'slowmode') {
      const segundos = acotar(solicitud.segundos, 0, MAX_SLOWMODE_SEG, 0);
      detalles.push(`**Modo lento:** ${segundos === 0 ? 'desactivado' : `${segundos}s de espera entre mensajes`}`);
    }

    const embed = brandEmbed({
      color: COLORS.warn,
      title: `${label.titulo} — confirmación requerida`,
      description:
        `${message.author} pidió por chat ${label.verbo}.\n` +
        `**Canal:** <#${message.channel.id}>\n` +
        (detalles.length ? `${detalles.join('\n')}\n` : '') +
        `**Motivo:** ${solicitud.motivo || '*sin especificar*'}`,
      footer: 'Solo el staff puede confirmar esta acción',
    });

    const fila = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ia_accion:si').setLabel('Ejecutar').setStyle(ButtonStyle.Danger).setEmoji('✅'),
      new ButtonBuilder().setCustomId('ia_accion:no').setLabel('Cancelar').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    cooldowns.set(message.author.id, Date.now());
    const panelCanal = await message.reply({ embeds: [embed], components: [fila] });
    pendientes.set(panelCanal.id, {
      tipo: 'canal',
      accion: solicitud.accion,
      canalId: message.channel.id,
      cantidad: solicitud.cantidad,
      segundos: solicitud.segundos,
      motivo: solicitud.motivo,
      solicitanteId: message.author.id,
      creada: Date.now(),
    });
    return;
  }

  // Resuelve al objetivo: mención directa o búsqueda por nombre en la caché.
  const mencion = message.mentions.members?.find((m) => m.id !== message.client.user.id);
  let miembro = mencion ?? null;
  if (!miembro) {
    const nombre = solicitud.objetivo.toLowerCase();
    miembro =
      message.guild.members.cache.find(
        (m) =>
          m.user.username.toLowerCase().includes(nombre) || m.displayName.toLowerCase().includes(nombre) || m.user.tag.toLowerCase().includes(nombre)
      ) ?? null;
  }

  if (!miembro) {
    await message.reply({
      embeds: [errorEmbed(`No encontré a **${solicitud.objetivo}** en el servidor. Probá mencionarlo directamente.`)],
    });
    return;
  }

  if (miembro.id === message.author.id) {
    await message.reply({ embeds: [errorEmbed('No podés pedir acciones de moderación sobre vos mismo.')] });
    return;
  }

  const label = LABELS[solicitud.accion];
  const embed = brandEmbed({
    color: COLORS.warn,
    title: `${label.titulo} — confirmación requerida`,
    description:
      `${message.author} pidió por chat que ${label.verbo} a **${miembro.user.tag}**.\n` +
      `**Motivo:** ${solicitud.motivo || '*sin especificar*'}` +
      (solicitud.accion === 'timeout' ? `\n**Duración:** ${solicitud.duracionMin} minutos` : ''),
    footer: 'Solo el staff puede confirmar esta acción',
  });

  const botones = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ia_accion:si').setLabel('Ejecutar').setStyle(ButtonStyle.Danger).setEmoji('✅'),
    new ButtonBuilder().setCustomId('ia_accion:no').setLabel('Cancelar').setStyle(ButtonStyle.Secondary).setEmoji('❌')
  );

  cooldowns.set(message.author.id, Date.now());
  const respuesta = await message.reply({ embeds: [embed], components: [botones] });
  pendientes.set(respuesta.id, {
    tipo: 'persona',
    accion: solicitud.accion,
    miembroId: miembro.id,
    motivo: solicitud.motivo,
    duracionMin: solicitud.duracionMin,
    solicitanteId: message.author.id,
    creada: Date.now(),
  });
}

// Maneja los clics en los botones de confirmación.
async function manejarBoton(interaction) {
  const datos = pendientes.get(interaction.message.id);
  if (!datos) {
    return interaction.update({
      embeds: [errorEmbed('Esta solicitud expiró. Pedila de nuevo.')],
      components: [],
    });
  }

  // Solo staff: el permiso que exige el comando equivalente más los roles de staff de
  // /config. Para una orden sobre el canal (/clear, /lockdown, /slowmode) no alcanza con
  // moderar miembros: hay que poder gestionar el canal.
  if (!puedeConfirmar(interaction, datos.accion)) {
    const falta = ACCIONES_CANAL.includes(datos.accion) ? 'Gestionar canales o mensajes en este servidor' : 'Moderar miembros';
    return interaction.reply({
      embeds: [errorEmbed(`Te falta el permiso de **${falta}** para confirmar esta acción.`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  pendientes.delete(interaction.message.id);

  if (interaction.customId.endsWith('no')) {
    return interaction.update({
      embeds: [brandEmbed({ color: COLORS.gris, title: '❌ Solicitud cancelada', description: `Cancelada por ${interaction.user}.` })],
      components: [],
    });
  }

  await interaction.deferUpdate();

  // Órdenes sobre el canal: el canal es donde vive el panel, o sea el mismo donde se
  // dio la orden. Se revalida igual que las acciones sobre personas.
  if (datos.tipo === 'canal' || ACCIONES_CANAL.includes(datos.accion)) {
    const canal = interaction.channel ?? (datos.canalId ? await interaction.guild.channels.fetch(datos.canalId).catch(() => null) : null);
    const errorCanal = validarAccionCanal(datos.accion, interaction, canal);
    if (errorCanal) {
      return interaction.editReply({ embeds: [errorEmbed(`No se puede ejecutar: ${errorCanal}`)], components: [] });
    }
    try {
      const resultadoCanal = await ejecutarAccionCanal(interaction, datos, canal);
      return interaction.editReply({
        embeds: [successEmbed(`${resultadoCanal}\n\nEjecutada por ${interaction.user}.`)],
        components: [],
      });
    } catch (error) {
      return interaction.editReply({ embeds: [errorEmbed(`Falló la ejecución: ${error.message}`)], components: [] });
    }
  }

  const miembro = await interaction.guild.members.fetch(datos.miembroId).catch(() => null);
  if (!miembro) {
    return interaction.editReply({ embeds: [errorEmbed('El usuario ya no está en el servidor.')], components: [] });
  }

  // Revalidación completa (dueño, bot, jerarquía, permisos del bot) ANTES de ejecutar:
  // las mismas reglas que los comandos normales, no confiamos ciegamente en la IA.
  const errorValidacion = validarAccionIA(datos.accion, interaction, miembro);
  if (errorValidacion) {
    return interaction.editReply({
      embeds: [errorEmbed(`No se puede ejecutar: ${errorValidacion}`)],
      components: [],
    });
  }

  try {
    const resultado = await ejecutarAccion(interaction, datos.accion, miembro, datos.motivo, datos.duracionMin);
    await interaction.editReply({
      embeds: [successEmbed(`${resultado}\n\nEjecutada por ${interaction.user}.`)],
      components: [],
    });
  } catch (error) {
    await interaction.editReply({
      embeds: [errorEmbed(`Falló la ejecución: ${error.message}`)],
      components: [],
    });
  }
}

module.exports = {
  pedirConfirmacion,
  manejarBoton,
  ejecutarAccion,
  validarAccionIA,
  // Órdenes sobre el canal y las reglas de quién puede pedirlas/confirmarlas: las usan
  // el propio panel, los tests y la lista blanca del detector de acciones (utils/ia.js).
  ejecutarAccionCanal,
  validarAccionCanal,
  puedeConfirmar,
  ACCIONES,
  ACCIONES_PERSONA,
  ACCIONES_CANAL,
};
