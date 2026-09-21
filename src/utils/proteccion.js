// Anti-spam y anti-raid automáticos.
//
// Spam: cuenta mensajes por usuario en una ventana móvil (ej: 5 mensajes en 5 s).
//   Al superarlo, ejecuta la acción configurada y avisa al staff.
// Raid: cuenta ingresos al server en una ventana (ej: 8 joins en 60 s).
//   Siempre avisa al staff; si el staff prendió la auto-acción, expulsa o banea
//   automáticamente a los recién ingresados con cuenta nueva.
//
// Config por server (config.proteccion, se edita desde /config → Anti-spam y anti-raid):
//   activado, accionSpam (aviso|timeout|mute|kick|ban), accionRaid (nada|kick|ban),
//   spamMensajes, spamSegundos, raidJoins, raidSegundos, accionesRapidas.
const { PermissionFlagsBits } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { brandEmbed } = require('./replies');
const { avisarPorDM } = require('./moderation');
const { logAction } = require('./modlog');

const POR_DEFECTO = {
  activado: false,
  accionSpam: 'timeout',
  accionRaid: 'kick',
  spamMensajes: 5,
  spamSegundos: 5,
  raidJoins: 8,
  raidSegundos: 60,
  accionesRapidas: false,
};

const ETIQUETA_ACCION_SPAM = { aviso: 'Borrar mensajes', timeout: 'Timeout 10 min', mute: 'Silenciar', kick: 'Expulsar', ban: 'Banear' };
const ETIQUETA_ACCION_RAID = { nada: 'Solo alerta', kick: 'Expulsar', ban: 'Banear' };
const DURACION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos
const EDAD_CUENTA_NUEVA_MS = 7 * 86400_000; // cuenta de menos de 7 días = "nueva" para raids

function configDe(guildId) {
  return { ...POR_DEFECTO, ...(getGuildConfig(guildId).proteccion || {}) };
}

// ---------- Estado en memoria (se pierde al reiniciar: es intencional) ----------
// Spam: clave "guildId:userId" → { stamps: [ts], mensajes: [{ id, channelId }] }
const ventanaSpam = new Map();
// Raid: clave guildId → { stamps: [ts], miembros: [{ id, tag, creado }] }
const ventanaRaid = new Map();
// Anti-repetición: no volver a castigar al mismo usuario ni alertar del mismo raid cada tanto.
const castigadoHasta = new Map();
const ultimaAlertaRaid = new Map();

const MSJ_SPAM = 10; // mensajes por usuario guardados como máximo
const COOLDOWN_CASTIGO_MS = 30_000; // entre castigos al mismo usuario
const COOLDOWN_ALERTA_RAID_MS = 60_000; // entre alertas de raid del mismo server

function limpiarViejo() {
  const ahora = Date.now();
  if (ventanaSpam.size > 1000) {
    for (const [k, v] of ventanaSpam) {
      if (!v.stamps.length || ahora - v.stamps[v.stamps.length - 1] > COOLDOWN_CASTIGO_MS) ventanaSpam.delete(k);
    }
  }
  if (castigadoHasta.size > 500) {
    for (const [k, hasta] of castigadoHasta) if (hasta < ahora) castigadoHasta.delete(k);
  }
}

// ---------- Alertas ----------
function canalDeAlertas(guild) {
  const config = getGuildConfig(guild.id);
  return guild.channels.cache.get(config.avisosChannel || config.logs || config.modlog) ?? null;
}

function alertar(guild, embed) {
  const canal = canalDeAlertas(guild);
  canal?.send({ embeds: [embed] }).catch(() => {});
}

// ---------- Acciones ----------
function puede(guild, permiso) {
  return Boolean(guild.members.me?.permissions.has(permiso));
}

async function borrarRafaga(guild, mensajes) {
  if (!puede(guild, PermissionFlagsBits.ManageMessages)) return 0;
  // Agrupa por canal: bulkDelete falla entero si algún mensaje tiene más de 14 días,
  // así que cada canal va con su propio lote y con force=true borra de a uno si hace falta.
  let borrados = 0;
  const porCanal = new Map();
  for (const m of mensajes) {
    if (!porCanal.has(m.channelId)) porCanal.set(m.channelId, []);
    porCanal.get(m.channelId).push(m.id);
  }
  for (const [canalId, ids] of porCanal) {
    const canal = guild.channels.cache.get(canalId);
    if (!canal?.bulkDelete) continue;
    const ok = await canal.bulkDelete(ids, true).catch(() => null);
    if (ok) borrados += ok.size;
  }
  return borrados;
}

async function aplicarMute(member, razon) {
  const muteRole = getGuildConfig(member.guild.id).muteRole;
  const rol = member.guild.roles.cache.get(muteRole);
  if (!rol) return false; // sin rol configurado: la vista del panel aclara el fallback
  await member.roles.add(rol, razon).catch(() => null);
  return true;
}

// Ejecuta la acción configurada sobre el miembro. Devuelve un texto con lo que hizo.
async function ejecutarAccion(member, accion, razon, tipo) {
  const guild = member.guild;
  const resultado = [];

  if (accion === 'timeout') {
    if (!puede(guild, PermissionFlagsBits.ModerateMembers)) return '⚠️ sin permiso de silenciar miembros';
    await member.timeout(DURACION_TIMEOUT_MS, razon).catch(() => null);
    resultado.push('timeout de 10 min');
  } else if (accion === 'mute') {
    const ok = await aplicarMute(member, razon);
    resultado.push(ok ? 'silenciado con rol' : '⚠️ sin rol de silenciado configurado (usé timeout)');
  } else if (accion === 'kick') {
    if (!puede(guild, PermissionFlagsBits.KickMembers)) return '⚠️ sin permiso de expulsar';
    await avisarPorDM(member.user, `Fuiste expulsado automáticamente de **${guild.name}**: ${razon}`);
    await member.kick(razon).catch(() => null);
    resultado.push('expulsado');
  } else if (accion === 'ban') {
    if (!puede(guild, PermissionFlagsBits.BanMembers)) return '⚠️ sin permiso de banear';
    await member.ban({ reason: razon, deleteMessageSeconds: 3600 }).catch(() => null);
    resultado.push('baneado');
  }

  logAction(guild, {
    action: tipo === 'spam' ? 'Anti-spam automático' : 'Anti-raid automático',
    color: tipo === 'spam' ? 0xfee75c : 0xed4245,
    target: member.user,
    moderator: guild.client.user,
    reason: razon,
    extra: `Acción automática (${accion}): ${resultado.join(', ') || 'solo alerta'}.`,
  });

  return resultado.join(', ') || 'solo alerta';
}

// ---------- Detección de spam (se llama en cada mensaje) ----------
// Devuelve true si se tomó una acción (para que el evento no siga procesando el mensaje).
async function procesarMensajeParaSpam(message) {
  const config = configDe(message.guild.id);
  if (!config.activado) return false;

  const member = message.member;
  // Exentos: staff con permiso de gestionar mensajes o el server. Nadie más.
  if (!member || member.permissions?.has(PermissionFlagsBits.ManageMessages) || member.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    return false;
  }

  const ahora = Date.now();
  const clave = `${message.guild.id}:${message.author.id}`;
  const registro = ventanaSpam.get(clave) ?? { stamps: [], mensajes: [] };

  registro.stamps.push(ahora);
  registro.mensajes.push({ id: message.id, channelId: message.channelId });
  if (registro.stamps.length > MSJ_SPAM) {
    registro.stamps.shift();
    registro.mensajes.shift();
  }
  ventanaSpam.set(clave, registro);

  // ¿Superó el umbral dentro de la ventana?
  const enVentana = registro.stamps.filter((t) => ahora - t <= config.spamSegundos * 1000);
  if (enVentana.length < config.spamMensajes) return false;
  if ((castigadoHasta.get(clave) ?? 0) > ahora) return false; // ya se lo castigó hace poco

  castigadoHasta.set(clave, ahora + COOLDOWN_CASTIGO_MS);
  limpiarViejo();

  const razon = `Anti-spam: ${enVentana.length} mensajes en ${config.spamSegundos} s`;
  const borrados = await borrarRafaga(message.guild, registro.mensajes);
  const resultadoAccion = config.accionSpam === 'aviso' ? 'solo borrado de mensajes' : await ejecutarAccion(member, config.accionSpam, razon, 'spam');

  await avisarPorDM(
    message.author,
    `⚠️ En **${message.guild.name}** se detectó que escribiste demasiado rápido (${enVentana.length} mensajes en ${config.spamSegundos} s).\n` +
      `Acción aplicada: **${ETIQUETA_ACCION_SPAM[config.accionSpam]}**. Escribí con calma para evitar sanciones.`
  );

  alertar(
    message.guild,
    brandEmbed({
      color: 0xfee75c,
      title: '🛡️ Anti-spam — posible flood detectado',
      description: `${member} (**${member.user.tag}**) superó el umbral: **${enVentana.length} mensajes en ${config.spamSegundos} s** en <#${message.channelId}>.`,
      fields: [
        { name: 'Acción aplicada', value: `${ETIQUETA_ACCION_SPAM[config.accionSpam]} → ${resultadoAccion}`, inline: true },
        { name: 'Mensajes borrados', value: `${borrados}`, inline: true },
      ],
      footer: 'TriggerBOT • acción automática, revisá que haya sido justa',
    })
  );

  return true;
}

// ---------- Detección de raid (se llama en cada ingreso) ----------
async function registrarIngreso(member) {
  const config = configDe(member.guild.id);
  if (!config.activado) return;

  const ahora = Date.now();
  const registro = ventanaRaid.get(member.guild.id) ?? { stamps: [], miembros: [] };

  registro.stamps.push(ahora);
  registro.miembros.push({ id: member.id, tag: member.user.tag, creado: member.user.createdTimestamp });
  if (registro.stamps.length > 50) {
    registro.stamps.shift();
    registro.miembros.shift();
  }
  ventanaRaid.set(member.guild.id, registro);

  const enVentana = registro.stamps.filter((t) => ahora - t <= config.raidSegundos * 1000);
  if (enVentana.length < config.raidJoins) return;
  if ((ultimaAlertaRaid.get(member.guild.id) ?? 0) > ahora - COOLDOWN_ALERTA_RAID_MS) return; // ya se alertó hace un momento

  ultimaAlertaRaid.set(member.guild.id, ahora);

  const recientes = registro.miembros.filter((m) => ahora - m.creado <= EDAD_CUENTA_NUEVA_MS);
  const listaMiembros = registro.miembros
    .slice(-10)
    .map((m) => `• <@${m.id}> — cuenta creada <t:${Math.floor(m.creado / 1000)}:R>${ahora - m.creado <= EDAD_CUENTA_NUEVA_MS ? ' 🆕' : ''}`)
    .join('\n');

  // Auto-acción: solo si el staff la prendió. Apunta a las cuentas nuevas con el rol menor.
  let aplicado = 'solo alerta';
  if (config.accionesRapidas && config.accionRaid !== 'nada') {
    const resultados = [];
    for (const m of registro.miembros.slice(-config.raidJoins)) {
      const objetivo = member.guild.members.cache.get(m.id);
      if (!objetivo || objetivo.user.bot) continue;
      if (ahora - objetivo.user.createdTimestamp > EDAD_CUENTA_NUEVA_MS) continue; // solo cuentas nuevas
      if (objetivo.roles.cache.size > 1) continue; // ya tiene roles: probablemente no es del raid
      const razon = `Anti-raid: ${enVentana.length} ingresos en ${config.raidSegundos} s`;
      const res = await ejecutarAccion(objetivo, config.accionRaid, razon, 'raid');
      resultados.push(res);
    }
    aplicado = resultados.length
      ? `${config.accionRaid} aplicado a ${resultados.length} cuenta(s) nueva(s)`
      : 'nadie calificó para auto-acción (cuentas nuevas sin roles)';
  }

  alertar(
    member.guild,
    brandEmbed({
      color: 0xed4245,
      title: '🚨 Anti-raid — oleada de ingresos detectada',
      description:
        `**${enVentana.length} ingresos en ${config.raidSegundos} s** (${recientes.length} con cuenta de menos de 7 días 🆕).\n` +
        (aplicado === 'solo alerta'
          ? 'Revisá la lista y actuá manualmente si corresponde.'
          : `Auto-acción: **${aplicado}**.`),
      fields: [{ name: 'Últimos ingresos', value: listaMiembros.slice(0, 1000) || '*—*' }],
      footer: 'TriggerBOT • activá la auto-acción en /config → Anti-spam y anti-raid si querés que actúe solo',
    })
  );
}

// Reinicia el estado (lo usan los tests).
function resetear() {
  ventanaSpam.clear();
  ventanaRaid.clear();
  castigadoHasta.clear();
  ultimaAlertaRaid.clear();
}

module.exports = { procesarMensajeParaSpam, registrarIngreso, configDe, resetear, POR_DEFECTO, ETIQUETA_ACCION_SPAM, ETIQUETA_ACCION_RAID, borrarRafaga, ejecutarAccion };
