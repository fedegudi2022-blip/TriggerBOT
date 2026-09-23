const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { logAction } = require('./modlog');
const { successEmbed, errorEmbed, brandEmbed, COLORS } = require('./replies');
const { validarAccionDelBot } = require('./moderation');

const LABELS = {
  warn: { titulo: '⚠️ Advertencia', verbo: 'advertir' },
  timeout: { titulo: '🔇 Silencio temporal', verbo: 'silenciar' },
  mute: { titulo: '🔇 Silencio (rol)', verbo: 'mutear' },
  kick: { titulo: '👢 Expulsión', verbo: 'expulsar' },
  ban: { titulo: '🔨 Baneo', verbo: 'banear' },
};

// Permiso concreto que el BOT necesita para cada acción (se valida antes de ejecutar).
const PERMISO_ACCION = {
  warn: PermissionFlagsBits.ModerateMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  mute: PermissionFlagsBits.ManageRoles,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
};

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

// Muestra el pedido de la IA con botones de confirmación (solo staff puede tocar).
async function pedirConfirmacion(message, solicitud) {
  // Anti-abuso: un mismo usuario no puede disparar confirmaciones sin pausa.
  const ultima = cooldowns.get(message.author.id) ?? 0;
  if (Date.now() - ultima < COOLDOWN_MS) {
    await message.reply('Tenés que esperar un poco antes de pedir otra acción de moderación por chat.');
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
          m.user.username.toLowerCase().includes(nombre) ||
          m.displayName.toLowerCase().includes(nombre) ||
          m.user.tag.toLowerCase().includes(nombre)
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

  // Solo staff: permisos de moderación o rol de staff configurado.
  const { getGuildConfig } = require('../store');
  const config = getGuildConfig(interaction.guildId);
  const esStaff =
    interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
    ['admin', 'mod', 'helper'].some((nivel) => interaction.member.roles.cache.has(config[`${nivel}Role`]));

  if (!esStaff) {
    return interaction.reply({
      embeds: [errorEmbed('Solo el staff puede confirmar acciones de moderación.')],
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

module.exports = { pedirConfirmacion, manejarBoton, ejecutarAccion, validarAccionIA };
