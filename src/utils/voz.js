// Canales de voz temporales ("Join-to-Create", estilo VoiceMaster).
//
// El staff configura un canal hub "➕ Crear canal" con /voz configurar. Al entrar,
// el bot crea un canal de voz a nombre del usuario, lo mueve y publica un panel
// de controles en el chat del canal: renombrar, límite de usuarios, cerrar/abrir,
// expulsar, transferir dueño, reclamar y borrar. El canal se borra solo cuando
// queda vacío y el dueño se transfiere automáticamente al salir.
//
// La lista de canales vivos se guarda en la config del server (data/config.json +
// respaldo en MariaDB como todo): si el bot se reinicia, recupera el seguimiento.
// Al arrancar, los canales temporales vacíos se limpian.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { brandEmbed } = require('./replies');
const { logEvent } = require('./log');
const crearLogger = require('../logger');
const log = crearLogger('voz');

const NOMBRE_HUB = '➕ Crear canal';
const PLANTILLA_NOMBRE = '🔊 Canal de Voz de {usuario}';
const MAX_CANALES_POR_GUILD = 25; // techo anti-flood (alguien entrando/saliendo en bucle)
const DELAY_BORRADO_MS = 2_000; // gracia por si se fue y vuelve enseguida

// ---------- Helpers puros (testeables, sin Discord) ----------
function nombreCanal(plantilla, nombreUsuario) {
  const base = String(plantilla || PLANTILLA_NOMBRE).replaceAll('{usuario}', String(nombreUsuario || 'usuario')).trim();
  return base.slice(0, 90) || PLANTILLA_NOMBRE.replaceAll('{usuario}', 'usuario');
}

function limiteValido(v) {
  if (typeof v === 'boolean') return null;
  const n = Math.round(Number(v));
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}

// Primer humano del canal (orden de ingreso del cache): el nuevo dueño si el actual se va.
function nuevoDueno(canal) {
  for (const miembro of canal.members.values()) {
    if (!miembro.user?.bot) return miembro;
  }
  return null;
}

// ---------- Registro de temporales (en la config → sync a MariaDB incluido) ----------
function vozDe(guildId) {
  return getGuildConfig(guildId).voz || {};
}
function temporalesDe(guildId) {
  return vozDe(guildId).temporales || {};
}
function esTemporal(guildId, canalId) {
  return Boolean(canalId && temporalesDe(guildId)[canalId]);
}
function duenoDe(guildId, canalId) {
  return temporalesDe(guildId)[canalId] ?? null;
}
function canalDeDueno(guildId, duenoId) {
  for (const [canalId, dueno] of Object.entries(temporalesDe(guildId))) {
    if (dueno === duenoId) return canalId;
  }
  return null;
}
// Categoría donde el staff quiere los canales temporales (config configurable con /voz categoria).
function categoriaDe(guildId) {
  return vozDe(guildId).categoriaId ?? null;
}

function registrarTemporal(guildId, canalId, duenoId) {
  setGuildConfig(guildId, (c) => {
    c.voz = c.voz || {};
    c.voz.temporales = c.voz.temporales || {};
    c.voz.temporales[canalId] = duenoId;
  });
}

function olvidarTemporal(guildId, canalId) {
  setGuildConfig(guildId, (c) => {
    if (c.voz?.temporales?.[canalId]) delete c.voz.temporales[canalId];
  });
}

// ---------- Permisos ----------
const PERMISOS_DUENO = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];

function esStaff(interaction) {
  if (interaction.member?.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  const config = getGuildConfig(interaction.guildId);
  return ['admin', 'mod', 'helper'].some((nivel) => interaction.member?.roles?.cache?.has(config[`${nivel}Role`]));
}

// ---------- Panel de controles (mensaje en el chat del canal de voz) ----------
function filaControles1() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('voz:nombre').setLabel('Renombrar').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('voz:limite').setLabel('Límite').setEmoji('👥').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('voz:lock').setLabel('Cerrar').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('voz:unlock').setLabel('Abrir').setEmoji('🔓').setStyle(ButtonStyle.Secondary)
  );
}

function filaControles2() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('voz:kick').setLabel('Expulsar').setEmoji('👢').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('voz:transferir').setLabel('Transferir').setEmoji('👑').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('voz:claim').setLabel('Reclamar').setEmoji('✋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('voz:borrar').setLabel('Borrar').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  );
}

function enviarPanel(canal, dueno) {
  const embed = brandEmbed({
    color: 0x5865f2,
    title: `🎧 Tu canal, ${dueno.displayName}`,
    description:
      'Controlá tu canal con estos botones.\n' +
      '• **Cerrar** bloquea la entrada de gente nueva.\n' +
      '• Si te vas, el dueño pasa a otro y si queda vacío **se borra solo**.',
  });
  return canal.send({ embeds: [embed], components: [filaControles1(), filaControles2()] });
}

// Categoría destino: al cambiarla, los canales temporales ya creados se mueven a la nueva.
// lockPermissions: false conserva los permisos del dueño (no sincroniza con la categoría).
async function moverTemporalesACategoria(guild, categoriaId) {
  const movidos = [];
  for (const canalId of Object.keys(temporalesDe(guild.id))) {
    const canal = guild.channels.cache.get(canalId);
    if (!canal) continue;
    await canal.setParent(categoriaId, { lockPermissions: false }).catch(() => {});
    movidos.push(canal);
  }
  return movidos;
}

// ---------- Creación al entrar al hub ----------
async function crearPara(state) {
  const guild = state.guild;
  const dueno = state.member;
  if (!dueno) return;

  // Ya tiene un canal suyo: lo mandamos al suyo en vez de crear otro.
  const existente = canalDeDueno(guild.id, dueno.id);
  if (existente) {
    const canal = guild.channels.cache.get(existente);
    if (canal) {
      await state.setChannel(canal).catch(() => {});
      return;
    }
    olvidarTemporal(guild.id, existente); // lo borraron a mano: sacar del registro
  }

  if (Object.keys(temporalesDe(guild.id)).length >= MAX_CANALES_POR_GUILD) {
    log.warn(`Límite de ${MAX_CANALES_POR_GUILD} canales temporales alcanzado en ${guild.name}`);
    return;
  }

  const config = vozDe(guild.id);
  // La categoría la elige el staff con /voz categoria; si no hay (o no existe), hereda la del hub.
  const categoria = config.categoriaId ? guild.channels.cache.get(config.categoriaId) : null;
  const padre =
    categoria?.type === ChannelType.GuildCategory
      ? categoria.id
      : (state.channel?.parentId ?? undefined);

  const canal = await guild.channels.create({
    name: nombreCanal(config.formato, dueno.displayName),
    type: ChannelType.GuildVoice,
    parent: padre,
    permissionOverwrites: [{ id: dueno.id, allow: PERMISOS_DUENO }],
  });

  registrarTemporal(guild.id, canal.id, dueno.id);
  await state.setChannel(canal).catch(() => {});
  await enviarPanel(canal, dueno).catch(() => {});
  log.info(`Canal temporal creado para ${dueno.user.tag} en ${guild.name}`);
  logEvent(guild, {
    color: 0x57f287,
    title: '🎧 Canal de voz temporal creado',
    description: `**${dueno.displayName}** entró al canal de creación y se le creó <#${canal.id}>.`,
    fields: padre ? [{ name: 'Categoría', value: `<#${padre}>` }] : [],
  });
}

// ---------- Transferencia de dueño ----------
async function transferirA(guild, canal, nuevoOwner, { silencioso = false } = {}) {
  const anteriorId = duenoDe(guild.id, canal.id);
  registrarTemporal(guild.id, canal.id, nuevoOwner.id);
  if (anteriorId && anteriorId !== nuevoOwner.id) {
    await canal.permissionOverwrites.delete(anteriorId).catch(() => {});
    logEvent(guild, {
      color: 0xfee75c,
      title: '👑 Canal de voz temporal transferido',
      description: `**${canal.name}** (<#${canal.id}>) pasó de <@${anteriorId}> a <@${nuevoOwner.id}>.`,
    });
  }
  await canal.permissionOverwrites.edit(nuevoOwner.id, { [PermissionFlagsBits.ManageChannels]: true, [PermissionFlagsBits.MoveMembers]: true, [PermissionFlagsBits.MuteMembers]: true }).catch(() => {});
  if (!silencioso) {
    await canal
      .send({ embeds: [brandEmbed({ color: 0xfee75c, title: `👑 ${nuevoOwner.displayName} ahora es el dueño del canal` })] })
      .catch(() => {});
  }
}

// ---------- Borrado con gracia (se cancela si alguien vuelve a entrar) ----------
const borradosAgendados = new Map(); // canalId → timeout

function programarBorrado(guildId, canal) {
  if (borradosAgendados.has(canal.id)) return;
  const t = setTimeout(async () => {
    borradosAgendados.delete(canal.id);
    const fresco = canal.guild.channels.cache.get(canal.id);
    if (!fresco) {
      olvidarTemporal(guildId, canal.id);
      return;
    }
    if (fresco.members.size > 0) return; // alguien volvió: no se borra
    const duenoId = duenoDe(guildId, canal.id);
    olvidarTemporal(guildId, canal.id);
    try {
      await fresco.delete('Canal de voz temporal vacío');
    } catch {
      /* sin permisos o ya borrado */
    }
    log.info(`Canal temporal vacío borrado (${fresco.name})`);
    logEvent(fresco.guild, {
      color: 0xed4245,
      title: '🗑️ Canal de voz temporal borrado',
      description: `**${fresco.name}** quedó vacío y se borró solo${duenoId ? ` (era de <@${duenoId}>)` : ''}.`,
    });
  }, DELAY_BORRADO_MS);
  t.unref?.();
  borradosAgendados.set(canal.id, t);
}

function cancelarBorrado(canalId) {
  clearTimeout(borradosAgendados.get(canalId));
  borradosAgendados.delete(canalId);
}

// ---------- Núcleo: reacción a cada cambio de voz ----------
async function manejarCambio(oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;

  const config = vozDe(guild.id);
  const hayTemporales = Object.keys(temporalesDe(guild.id)).length > 0;
  if (!config.hubId && !hayTemporales) return;

  // 1) Alguien entró al hub → crear (o reusar) su canal temporal.
  if (config.hubId && newState.channelId === config.hubId && oldState.channelId !== config.hubId) {
    await crearPara(newState);
  }

  // 2) Algún canal temporal fue afectado por el cambio.
  const canalId = [oldState.channelId, newState.channelId].find((id) => id && esTemporal(guild.id, id));
  if (!canalId) return;
  const canal = guild.channels.cache.get(canalId);
  if (!canal) {
    olvidarTemporal(guild.id, canalId); // lo borraron a mano
    return;
  }

  if (newState.channelId === canalId) cancelarBorrado(canalId); // alguien entró/volvió

  if (canal.members.size === 0) {
    programarBorrado(guild.id, canal);
    return;
  }

  // 3) El dueño se fue pero queda gente: el dueño pasa al primer humano.
  const duenoId = duenoDe(guild.id, canalId);
  if (duenoId && !canal.members.has(duenoId)) {
    const reemplazo = nuevoDueno(canal);
    if (reemplazo) await transferirA(guild, canal, reemplazo);
  }
}

// ---------- Controles (botones, selects y modales del panel) ----------
function opcionMiembros(canal, { excluir = [] } = {}) {
  return [...canal.members.values()]
    .filter((m) => !m.user?.bot && !excluir.includes(m.id))
    .slice(0, 25) // límite de opciones de Discord
    .map((m) => ({ label: m.displayName.slice(0, 100), value: m.id }));
}

async function manejarComponente(interaction) {
  const accion = interaction.customId.split(':')[1];
  const guild = interaction.guild;
  const canal = interaction.channel;

  if (!guild || !canal || !esTemporal(guild.id, canal.id)) {
    return interaction.reply({ content: 'Este panel ya no corresponde a un canal activo.', flags: MessageFlags.Ephemeral });
  }

  const duenoId = duenoDe(guild.id, canal.id);

  // Reclamar: el dueño actual ya no está en el canal → cualquiera adentro puede tomarlo.
  if (accion === 'claim') {
    if (!interaction.member?.voice || interaction.member.voice.channelId !== canal.id) {
      return interaction.reply({ content: 'Tenés que estar adentro del canal para reclamarlo.', flags: MessageFlags.Ephemeral });
    }
    if (canal.members.has(duenoId)) {
      return interaction.reply({ content: 'El dueño sigue en el canal: no se puede reclamar.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferUpdate();
    await transferirA(guild, canal, interaction.member);
    return;
  }

  if (!esStaff(interaction) && interaction.user.id !== duenoId) {
    return interaction.reply({ content: 'Solo el dueño del canal (o el staff) puede usar estos controles.', flags: MessageFlags.Ephemeral });
  }

  switch (accion) {
    case 'nombre': {
      const modal = new ModalBuilder()
        .setCustomId('voz:modal:nombre')
        .setTitle('Renombrar canal')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('nombre')
              .setLabel('Nuevo nombre (máx. 90)')
              .setStyle(TextInputStyle.Short)
              .setValue(canal.name)
              .setMaxLength(90)
              .setRequired(true)
          )
        );
      return interaction.showModal(modal);
    }

    case 'limite': {
      const modal = new ModalBuilder()
        .setCustomId('voz:modal:limite')
        .setTitle('Límite de usuarios')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('limite')
              .setLabel('Cantidad (0 = sin límite, máx. 99)')
              .setStyle(TextInputStyle.Short)
              .setValue(String(canal.userLimit ?? 0))
              .setMaxLength(2)
              .setRequired(true)
          )
        );
      return interaction.showModal(modal);
    }

    case 'lock':
      await canal.permissionOverwrites.edit(guild.roles.everyone, { [PermissionFlagsBits.Connect]: false }).catch(() => {});
      return interaction.reply({ content: '🔒 Canal **cerrado**: solo pueden entrar quienes ya están adentro.', flags: MessageFlags.Ephemeral });

    case 'unlock':
      await canal.permissionOverwrites.edit(guild.roles.everyone, { [PermissionFlagsBits.Connect]: null }).catch(() => {});
      return interaction.reply({ content: '🔓 Canal **abierto** para todos.', flags: MessageFlags.Ephemeral });

    case 'kick': {
      const opciones = opcionMiembros(canal, { excluir: [duenoId, interaction.user.id] });
      if (!opciones.length) {
        return interaction.reply({ content: 'No hay nadie más que puedas expulsar (vos y el dueño quedan excluidos).', flags: MessageFlags.Ephemeral });
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId('voz:sel:kick')
        .setPlaceholder('Elegí a quién expulsar del canal')
        .addOptions(opciones);
      return interaction.reply({
        content: '👢 Elegí al usuario a expulsar:',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
    }

    case 'transferir': {
      const opciones = opcionMiembros(canal, { excluir: [interaction.user.id] });
      if (!opciones.length) {
        return interaction.reply({ content: 'No hay nadie más adentro a quien transferirle el canal.', flags: MessageFlags.Ephemeral });
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId('voz:sel:transferir')
        .setPlaceholder('Elegí el nuevo dueño del canal')
        .addOptions(opciones);
      return interaction.reply({
        content: '👑 Elegí quién va a ser el nuevo dueño:',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
    }

    case 'borrar':
      olvidarTemporal(guild.id, canal.id);
      await interaction.reply({ content: '🗑️ Cerrando tu canal...', flags: MessageFlags.Ephemeral }).catch(() => {});
      await canal.delete('Dueño cerró su canal temporal').catch(() => {});
      logEvent(guild, {
        color: 0xed4245,
        title: '🗑️ Canal de voz temporal borrado',
        description: `**${canal.name}** (de <@${duenoId}>) fue cerrado por <@${interaction.user.id}>.`,
      });
      return;

    default:
      return interaction.reply({ content: 'Acción desconocida.', flags: MessageFlags.Ephemeral });
  }
}

// Selects del panel (expulsar / transferir).
async function manejarSelect(interaction) {
  const [, , tipo] = interaction.customId.split(':'); // voz:sel:kick|transferir
  const guild = interaction.guild;
  const canal = interaction.channel;
  if (!canal || !esTemporal(guild.id, canal.id)) {
    return interaction.update({ content: 'Este canal ya no existe.', components: [] });
  }
  const duenoId = duenoDe(guild.id, canal.id);
  const objetivo = guild.members.cache.get(interaction.values[0]);
  await interaction.deferUpdate();

  if (!objetivo || !canal.members.has(objetivo.id)) {
    return interaction.followUp({ content: 'Ese usuario ya no está en el canal.', flags: MessageFlags.Ephemeral });
  }

  if (tipo === 'kick') {
    if (objetivo.id === duenoId) {
      return interaction.followUp({ content: 'No podés expulsar al dueño; transferríle el canal primero.', flags: MessageFlags.Ephemeral });
    }
    await objetivo.voice?.disconnect(`Expulsado del canal temporal por ${interaction.user.tag}`).catch(() => {});
    return interaction.followUp({ content: `👢 Expulsaste a **${objetivo.displayName}** del canal.`, flags: MessageFlags.Ephemeral });
  }

  if (tipo === 'transferir') {
    await transferirA(guild, canal, objetivo);
    return interaction.followUp({ content: `👑 **${objetivo.displayName}** ahora es el dueño del canal.`, flags: MessageFlags.Ephemeral });
  }
}

// Modales del panel (renombrar / límite).
async function manejarModal(interaction) {
  const [, , tipo] = interaction.customId.split(':'); // voz:modal:nombre|limite
  const guild = interaction.guild;
  const canal = interaction.channel;
  if (!canal || !esTemporal(guild.id, canal.id)) {
    return interaction.reply({ content: 'Este canal ya no existe.', flags: MessageFlags.Ephemeral });
  }
  if (!esStaff(interaction) && interaction.user.id !== duenoDe(guild.id, canal.id)) {
    return interaction.reply({ content: 'Solo el dueño del canal (o el staff) puede usar estos controles.', flags: MessageFlags.Ephemeral });
  }

  if (tipo === 'nombre') {
    const nombre = interaction.fields.getTextInputValue('nombre').trim().slice(0, 90);
    if (!nombre) return interaction.reply({ content: 'El nombre no puede quedar vacío.', flags: MessageFlags.Ephemeral });
    await canal.setName(nombre, `Renombrado por ${interaction.user.tag}`).catch(() => {});
    return interaction.reply({ content: `📝 Canal renombrado a **${nombre}**.`, flags: MessageFlags.Ephemeral });
  }

  if (tipo === 'limite') {
    const limite = limiteValido(interaction.fields.getTextInputValue('limite'));
    if (limite === null) return interaction.reply({ content: 'Límite inválido: usá un número de 0 a 99 (0 = sin límite).', flags: MessageFlags.Ephemeral });
    await canal.setUserLimit(limite, `Límite ajustado por ${interaction.user.tag}`).catch(() => {});
    return interaction.reply({
      content: limite === 0 ? '👥 Límite quitado: canal abierto para todos.' : `👥 Límite fijado en **${limite}** usuarios.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// Limpieza al arrancar: los temporales vacíos (huérfanos de un reinicio) se borran.
async function limpiarAlArrancar(client) {
  for (const guild of client.guilds.cache.values()) {
    const temporales = temporalesDe(guild.id);
    for (const canalId of Object.keys(temporales)) {
      const canal = guild.channels.cache.get(canalId);
      if (!canal) {
        olvidarTemporal(guild.id, canalId);
        continue;
      }
      if (canal.members.size === 0) {
        const duenoId = temporales[canalId];
        olvidarTemporal(guild.id, canalId);
        await canal.delete('Limpieza al arrancar: canal temporal vacío').catch(() => {});
        logEvent(guild, {
          color: 0xed4245,
          title: '🗑️ Canal de voz temporal borrado',
          description: `**${canal.name}** (de <@${duenoId}>) quedó vacío tras un reinicio y se limpió.`,
        });
      }
    }
  }
}

module.exports = {
  NOMBRE_HUB,
  PLANTILLA_NOMBRE,
  nombreCanal,
  vozDe,
  temporalesDe,
  categoriaDe,
  limiteValido,
  nuevoDueno,
  esTemporal,
  duenoDe,
  canalDeDueno,
  registrarTemporal,
  olvidarTemporal,
  moverTemporalesACategoria,
  manejarCambio,
  manejarComponente,
  manejarSelect,
  manejarModal,
  limpiarAlArrancar,
};
