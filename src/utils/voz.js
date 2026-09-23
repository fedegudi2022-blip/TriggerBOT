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
//
// Convenciones de esta versión:
//  - Toda operación contra Discord devuelve un resultado { ok, error }: nunca se
//    informa "canal cerrado/renombrado/expulsado" si Discord rechazó la acción.
//  - El registro de temporales muta la config EN MEMORIA al instante, pero la
//    escritura a disco se agrupa con debounce (store.mutarYAgendar): una ráfaga
//    de entradas/salidas = una sola escritura. `volcarTodo()` del apagado la
//    fuerza (store.volcar), así un apagado controlado no pierde nada.
//  - El fallback de creación fuera de la categoría configurada está APAGADO por
//    defecto (voz.fallbackCategoriaHub = true para habilitarlo, en config).

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
const { getGuildConfig, setGuildConfig, mutarYAgendar } = require('../store');
const { brandEmbed, successEmbed } = require('./replies');
const { logEvent } = require('./log');
const crearLogger = require('../logger');
const log = crearLogger('voz');

const NOMBRE_HUB = '➕ Crear canal';
const PLANTILLA_NOMBRE = '🔊 Canal de Voz de {usuario}';
const MAX_CANALES_POR_GUILD = 25; // techo por defecto (anti-flood), configurable con /voz limite
const MIN_CANALES_POR_GUILD = 1;
const MAX_LIMITE_CANALES = 50;
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

// Límite de canales temporales por server: 1 a 50 (config con /voz limite).
function limiteCanalesValido(v) {
  const n = Math.round(Number(v));
  return Number.isInteger(n) && n >= MIN_CANALES_POR_GUILD && n <= MAX_LIMITE_CANALES ? n : null;
}

// Nombre con contador de usuarios: «base · 3» o «base · 3/5» si tiene límite.
function nombreConContador(base, cantidad, limite) {
  const sufijo = limite > 0 ? `${cantidad}/${limite}` : `${cantidad}`;
  return `${nombreBaseDe(base)} · ${sufijo}`.slice(0, 100);
}

// Quita el sufijo del contador para recalcular siempre sobre el nombre base.
function nombreBaseDe(nombre) {
  return String(nombre || '').replace(/\s·\s\d+(\/\d+)?$/, '').trim();
}

// Bitrate permitido (bits/s). Discord acepta 8.000-96.000 en general, hasta
// 384.000 con nivel 3 de boosts; sin boosts el server suele topear en 96k.
function bitrateValido(v) {
  const n = Math.round(Number(v));
  if (!Number.isInteger(n)) return null;
  if (n === 0) return 0; // 0 = región automática del server (restaura)
  return n >= 8_000 && n <= 384_000 ? n : null;
}

// Región RTC válida para voice.setRTCRegion(null = automática).
const REGIONES_RTC = new Set([
  'us-west', 'us-south', 'us-east', 'us-central', 'singapore', 'southafrica', 'sydney', 'brazil',
  'hongkong', 'russia', 'japan', 'india', 'south-korea', 'europe', 'dubai', 'atlanta',
]);
function regionValida(v) {
  const valor = String(v ?? '').trim();
  if (!valor || valor === 'auto') return null; // null = automática
  return REGIONES_RTC.has(valor) ? valor : undefined; // undefined = inválida
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

// Límite de canales temporales configurado (o el techo por defecto).
function limiteCanales(guildId) {
  const n = Number(vozDe(guildId).limiteCanales);
  return Number.isInteger(n) && n >= MIN_CANALES_POR_GUILD && n <= MAX_LIMITE_CANALES ? n : MAX_CANALES_POR_GUILD;
}

// Fallback: si la categoría configurada falla, ¿se permite crear fuera de ella
// (categoría del hub y luego sin categoría)? APAGADO por defecto: si la creación
// en la categoría elegida falla, se avisa y no se desordena el server. El staff
// lo habilita a propósito con /voz categoria → permitir_fallback (o config directa).
function fallbackActivo(guildId) {
  return vozDe(guildId).fallbackCategoriaHub === true;
}

// Nivel de registro de eventos en el canal de logs ('todo' | 'errores' | 'nada'),
// elegido con /voz logs. Por defecto solo errores: registrar una creación/borrado
// por cada entrada/salida convertía el canal de logs en spam.
function nivelEventos(guildId) {
  return vozDe(guildId).eventos || 'errores';
}

// Contador de usuarios en el nombre del canal («· 3/5»): prendido por defecto,
// apagable con /voz contador.
function contadorActivo(guildId) {
  return vozDe(guildId).contador !== false;
}

// Eventos rutinarios (creación, transferencia, borrado): solo se publican con nivel "todo".
// Los errores (no se pudo crear un canal) se registran siempre: son accionables para el staff.
function registrarEvento(guild, evento) {
  if (nivelEventos(guild.id) !== 'todo') return;
  logEvent(guild, evento);
}

// Registro con escritura agrupada: el cache cambia al instante, el disco con debounce.
function registrarTemporal(guildId, canalId, duenoId) {
  mutarYAgendar(guildId, (c) => {
    c.voz = c.voz || {};
    c.voz.temporales = c.voz.temporales || {};
    c.voz.temporales[canalId] = duenoId;
  });
}

function olvidarTemporal(guildId, canalId) {
  mutarYAgendar(guildId, (c) => {
    if (c.voz?.temporales?.[canalId]) delete c.voz.temporales[canalId];
  });
  limpiarColaRenombre(canalId); // ya no hay nada que renombrar si el canal se va
}

// ---------- Permisos ----------
const PERMISOS_DUENO = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];
// El dueño también necesita el chat de su canal de voz: si la categoría bloquea
// mensajes, el panel no se publica y el canal queda sin controles.
const PERMISOS_CHAT_DUENO = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
];

// Staff: quien puede gestionar canales o tiene un rol de staff configurado.
function esStaffMiembro(guild, member) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageChannels)) return true;
  const config = getGuildConfig(guild.id);
  return ['admin', 'mod', 'helper'].some((nivel) => member.roles?.cache?.has(config[`${nivel}Role`]));
}

// ¿El actor puede controlar este canal? Dueño actual o staff. Se revalida SIEMPRE
// antes de ejecutar: el dueño puede haber cambiado mientras el menú estaba abierto.
function puedeControlar(guild, member, duenoId) {
  if (!member) return false;
  return member.id === duenoId || esStaffMiembro(guild, member);
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

function filaControles3() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('voz:permitir').setLabel('Permitir').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('voz:bloquear').setLabel('Bloquear').setEmoji('🚫').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('voz:avanzado').setLabel('Ajustes').setEmoji('⚙️').setStyle(ButtonStyle.Primary)
  );
}

function enviarPanel(canal, dueno) {
  const embed = brandEmbed({
    color: 0x5865f2,
    title: `🎧 Tu canal, ${dueno.displayName}`,
    description:
      'Controlá tu canal con estos botones.\n' +
      '• **Cerrar** bloquea la entrada de gente nueva (⏱️ **Ajustes** permite cerrar por un tiempo).\n' +
      '• **Permitir / Bloquear** controlan quién puede entrar, incluso con el canal abierto.\n' +
      '• Si te vas, el dueño pasa a otro y si queda vacío **se borra solo**.',
  });
  return canal.send({ embeds: [embed], components: [filaControles1(), filaControles2(), filaControles3()] });
}

// Registros muertos (el canal ya no existe en el server): se sacan de la config.
function limpiarRegistrosMuertos(guild) {
  const muertos = Object.keys(temporalesDe(guild.id)).filter((canalId) => !guild.channels.cache.has(canalId));
  if (!muertos.length) return;
  mutarYAgendar(guild.id, (c) => {
    for (const canalId of muertos) {
      if (c.voz?.temporales?.[canalId]) delete c.voz.temporales[canalId];
    }
  });
}

// Si la creación falla, se lo decimos al usuario en el chat del hub (los canales de voz
// aceptan mensajes) y al staff en los logs, con el motivo exacto.
async function avisarFallo(guild, dueno, motivo) {
  const texto = String(motivo?.message || motivo).slice(0, 500);
  const hub = guild.channels.cache.get(vozDe(guild.id).hubId);
  if (hub?.send) {
    await hub
      .send({
        embeds: [
          brandEmbed({
            color: 0xed4245,
            title: '⚠️ No se pudo crear tu canal',
            description: `<@${dueno.id}>, algo falló al crear tu canal de voz:\n\`${texto}\`\nAvisale al staff para que revise los permisos del bot.`,
          }),
        ],
      })
      .catch(() => {});
  }
  logEvent(guild, {
    color: 0xed4245,
    title: '⚠️ Error creando canal temporal',
    description: `No se pudo crear el canal de voz para **${dueno.displayName}** (<@${dueno.id}>).`,
    fields: [{ name: 'Motivo', value: texto }],
  });
}

// ---------- Operaciones de Discord con resultado real ----------
// Nada de .catch(() => {}) silenciosos: si Discord rechaza, el usuario lo ve y
// el motivo queda en el log. Cada helper devuelve { ok, error }.

async function opRename(canal, nombre, motivo) {
  try {
    await canal.setName(nombre, motivo);
    return { ok: true };
  } catch (error) {
    log.warn(`setName falló (${canal.id}): ${error.message}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

async function opLimite(canal, limite, motivo) {
  try {
    await canal.setUserLimit(limite, motivo);
    return { ok: true };
  } catch (error) {
    log.warn(`setUserLimit falló (${canal.id}): ${error.message}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

async function opBitrate(canal, bitrate, motivo) {
  try {
    await canal.setBitrate(bitrate, motivo);
    return { ok: true };
  } catch (error) {
    log.warn(`setBitrate falló (${canal.id}): ${error.message}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

async function opRegion(canal, region, motivo) {
  try {
    await canal.setRTCRegion(region, motivo);
    return { ok: true };
  } catch (error) {
    log.warn(`setRTCRegion falló (${canal.id}): ${error.message}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

async function opOverwrite(canal, id, permisos, _motivo) {
  // motivo queda en el audit log de Discord vía permissionOverwrites.edit
  try {
    await canal.permissionOverwrites.edit(id, permisos);
    return { ok: true };
  } catch (error) {
    log.warn(`permissionOverwrites.edit falló (${canal.id}): ${error.message}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

async function opQuitarOverwrite(canal, id, motivo) {
  try {
    await canal.permissionOverwrites.delete(id, motivo);
    return { ok: true };
  } catch (error) {
    log.warn(`permissionOverwrites.delete falló (${canal.id}): ${error.message}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

async function opBorrar(canal, motivo) {
  try {
    await canal.delete(motivo);
    return { ok: true };
  } catch (error) {
    log.warn(`delete falló (${canal?.id}): ${error.message}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

async function opDisconnect(miembro, motivo) {
  try {
    await miembro.voice?.disconnect(motivo);
    return { ok: true };
  } catch (error) {
    log.warn(`disconnect falló (${miembro?.id}): ${error.message}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

// ---------- Listas de permitidos y bloqueados (persisten con el canal) ----------
// Guardadas EN el canal como overwrites individuales de Connect: sobreviven
// reinicios (Discord las mantiene), no inflan la config y se limpian al borrar.
function permitidosDe(canal, everyoneId) {
  const salida = [];
  for (const [, overwrite] of canal.permissionOverwrites.cache ?? []) {
    const allow = BigInt(overwrite.allow ?? 0n);
    const deny = BigInt(overwrite.deny ?? 0n);
    if (overwrite.id === everyoneId) continue;
    if (allow & PermissionFlagsBits.Connect) salida.push({ id: overwrite.id, tipo: 'permitido' });
    else if (deny & PermissionFlagsBits.Connect) salida.push({ id: overwrite.id, tipo: 'bloqueado' });
  }
  return salida;
}

function estaBloqueado(canal, userId) {
  for (const [, overwrite] of canal.permissionOverwrites.cache ?? []) {
    if (overwrite.id !== userId) continue;
    const deny = BigInt(overwrite.deny ?? 0n);
    if (deny & PermissionFlagsBits.Connect) return true;
  }
  return false;
}

// ---------- Categoría: elegir dónde crear y mover los existentes ----------
function parentDe(guild, config, canalHub) {
  const categoriaId = config.categoriaId;
  if (categoriaId) {
    const categoria = guild.channels.cache.get(categoriaId);
    if (categoria?.type === ChannelType.GuildCategory) return categoria.id;
  }
  return canalHub?.parentId ?? null;
}

// Categoría destino: al cambiarla, los canales temporales ya creados se mueven a la nueva.
// lockPermissions: false conserva los permisos del dueño (no sincroniza con la categoría).
// Devuelve { movidos, fallidos }: un canal que Discord rechaza NO se informa como movido.
async function moverTemporalesACategoria(guild, categoriaId) {
  const movidos = [];
  const fallidos = [];
  for (const canalId of Object.keys(temporalesDe(guild.id))) {
    const canal = guild.channels.cache.get(canalId);
    if (!canal) continue;
    try {
      await canal.setParent(categoriaId, { lockPermissions: false });
      movidos.push(canal);
    } catch (error) {
      log.warn(`No se pudo mover ${canal.name} (${canalId}) a la categoría ${categoriaId}: ${error.message}`);
      fallidos.push({ canal, canalId, motivo: error?.message ?? String(error) });
    }
  }
  return { movidos, fallidos };
}

// ---------- Creación al entrar al hub ----------
// Bloqueo de creación por guildId:userId: dos voiceStateUpdate casi simultáneos
// (reconexiones de voz, altas cargas de Discord) se resuelven a UN solo canal:
// el segundo espera el bloqueo y re-chequea (ya existe canal → lo reusa).
const creacionesEnCurso = new Map(); // clave guildId:userId → Promise de la creación

async function crearPara(state) {
  const guild = state.guild;
  const dueno = state.member;
  if (!dueno) return;
  const clave = `${guild.id}:${dueno.id}`;

  // Reusar promesa en curso: la segunda llamada concurrente espera y re-chequea.
  if (creacionesEnCurso.has(clave)) {
    try {
      await creacionesEnCurso.get(clave);
    } catch {
      /* la original ya avisó su propio fallo */
    }
    const existenteTrasEspera = canalDeDueno(guild.id, dueno.id);
    if (existenteTrasEspera) {
      const canal = guild.channels.cache.get(existenteTrasEspera);
      if (canal) await state.setChannel(canal).catch(() => {});
    }
    return;
  }

  const promesa = crearParaInterno(state);
  creacionesEnCurso.set(clave, promesa);
  try {
    await promesa;
  } finally {
    // Se libera SIEMPRE, incluso si Discord devolvió un error: un fallo no
    // puede dejar al usuario bloqueado para siempre.
    creacionesEnCurso.delete(clave);
  }
}

async function crearParaInterno(state) {
  const guild = state.guild;
  const dueno = state.member;

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

  // Canales borrados a mano que quedaron registrados: no cuentan para el límite ni bloquean la creación.
  limpiarRegistrosMuertos(guild);

  // Re-chequeo post-bloqueo: la llamada original ya pudo registrar el canal.
  const yaExiste = canalDeDueno(guild.id, dueno.id);
  if (yaExiste) {
    const canal = guild.channels.cache.get(yaExiste);
    if (canal) {
      await state.setChannel(canal).catch(() => {});
      return;
    }
    olvidarTemporal(guild.id, yaExiste);
  }

  const tope = limiteCanales(guild.id);
  if (Object.keys(temporalesDe(guild.id)).length >= tope) {
    log.warn(`Límite de ${tope} canales temporales alcanzado en ${guild.name}`);
    await avisarFallo(guild, dueno, `Límite de ${tope} canales temporales alcanzado (anti-flood). Probá en un rato.`);
    return;
  }

  const config = vozDe(guild.id);
  const canalHub = config.hubId ? guild.channels.cache.get(config.hubId) : null;
  const padre = parentDe(guild, config, canalHub);

  // Intentamos la categoría elegida; solo si el fallback está habilitado
  // (voz.fallbackCategoriaHub) reintentamos con la categoría del hub y sin
  // categoría. Por defecto el fallo se informa y no se desordena el server.
  const nombreBase = nombreCanal(config.formato, dueno.displayName);
  // El dueño aterriza apenas lo movemos: nace con el contador ya en 1 (si está prendido).
  const opcionesBase = {
    name: contadorActivo(guild.id) ? nombreConContador(nombreBase, 1, 0) : nombreBase,
    type: ChannelType.GuildVoice,
    permissionOverwrites: [
      // Permisos de voz del dueño + chat de su canal: sin SendMessages la
      // categoría podría impedir publicar el panel de controles.
      {
        id: dueno.id,
        allow: [...PERMISOS_DUENO, ...PERMISOS_CHAT_DUENO],
      },
    ],
  };
  const candidatos = fallbackActivo(guild.id)
    ? [...new Set([padre, canalHub?.parentId ?? null, null])]
    : [padre];
  let canal = null;
  let ultimoError = null;
  let conFallback = false;
  for (const candidato of candidatos) {
    try {
      canal = await guild.channels.create({ ...opcionesBase, parent: candidato });
      break;
    } catch (error) {
      ultimoError = error;
      conFallback = true;
    }
  }
  if (!canal) {
    log.error(`No se pudo crear el canal temporal para ${dueno.user?.tag ?? dueno.id} en ${guild.name}: ${ultimoError?.message}`);
    await avisarFallo(guild, dueno, ultimoError);
    return;
  }
  limpiarColaRenombre(canal.id); // canal nuevo: sin renombres pendientes de una vida anterior
  if (conFallback) {
    log.warn(`Canal temporal creado fuera de la categoría configurada (último error: ${ultimoError?.message})`);
  }

  registrarTemporal(guild.id, canal.id, dueno.id);
  await state.setChannel(canal).catch(() => {});
  await enviarPanel(canal, dueno).catch(() => {});
  log.info(`Canal temporal creado para ${dueno.user?.tag ?? dueno.id} en ${guild.name}`);
  registrarEvento(guild, {
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
    await opQuitarOverwrite(canal, anteriorId, `Transferencia del canal temporal a ${nuevoOwner.id}`);
    registrarEvento(guild, {
      color: 0xfee75c,
      title: '👑 Canal de voz temporal transferido',
      description: `**${canal.name}** (<#${canal.id}>) pasó de <@${anteriorId}> a <@${nuevoOwner.id}>.`,
    });
  }
  await opOverwrite(
    canal,
    nuevoOwner.id,
    {
      [PermissionFlagsBits.ManageChannels]: true,
      [PermissionFlagsBits.MoveMembers]: true,
      [PermissionFlagsBits.MuteMembers]: true,
      [PermissionFlagsBits.ViewChannel]: true,
      [PermissionFlagsBits.SendMessages]: true,
      [PermissionFlagsBits.ReadMessageHistory]: true,
    },
    'Nuevo dueño del canal temporal'
  );
  if (!silencioso) {
    await canal
      .send({ embeds: [brandEmbed({ color: 0xfee75c, title: `👑 ${nuevoOwner.displayName} ahora es el dueño del canal` })] })
      .catch(() => {});
  }
}

// ---------- Borrado con gracia (se cancela si alguien vuelve a entrar) ----------
const borradosAgendados = new Map(); // canalId → timeout

// ---------- Contador en el nombre (respeta el límite de renombres de Discord) ----------
// Discord permite solo 2 renombres por canal cada 10 minutos: la cola junta los
// cambios y aplica siempre el valor más nuevo apenas se libera el cupo.
const RENOMBRES_POR_VENTANA = 2;
const VENTANA_RENOMBRE_MS = 10 * 60 * 1000;
const colasRenombre = new Map(); // canalId → { sellos: number[], timer }

function limpiarColaRenombre(canalId) {
  const cola = colasRenombre.get(canalId);
  if (cola?.timer) clearTimeout(cola.timer);
  colasRenombre.delete(canalId);
}

function refrescarContador(guild, canal) {
  if (!canal || !contadorActivo(guild.id)) return;
  const deseado = nombreConContador(nombreBaseDe(canal.name), canal.members.size, canal.userLimit);
  if (canal.name === deseado) return;

  const cola = colasRenombre.get(canal.id) ?? { sellos: [], timer: null };
  colasRenombre.set(canal.id, cola);

  const intento = async () => {
    const fresco = guild.channels.cache.get(canal.id);
    if (!fresco) return limpiarColaRenombre(canal.id); // lo borraron mientras esperaba
    const ahora = Date.now();
    cola.sellos = cola.sellos.filter((sello) => ahora - sello < VENTANA_RENOMBRE_MS);
    // Se recalcula con el estado actual del canal, no con el pedido viejo.
    const objetivo = nombreConContador(nombreBaseDe(fresco.name), fresco.members.size, fresco.userLimit);
    if (fresco.name === objetivo) return;
    if (cola.sellos.length >= RENOMBRES_POR_VENTANA) {
      if (!cola.timer) {
        const espera = VENTANA_RENOMBRE_MS - (ahora - cola.sellos[0]) + 1_000;
        cola.timer = setTimeout(() => {
          cola.timer = null;
          intento();
        }, espera);
        cola.timer.unref?.();
      }
      return;
    }
    cola.sellos.push(ahora);
    const resultado = await opRename(fresco, objetivo, 'Contador de usuarios del canal temporal');
    if (!resultado.ok) limpiarColaRenombre(canal.id); // Discord rechazó: no insistir en bucle
  };
  intento();
}

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
    const resultado = await opBorrar(fresco, 'Canal de voz temporal vacío');
    if (!resultado.ok) return; // sin permisos: queda vivo, no anunciamos un borrado que no pasó
    log.info(`Canal temporal vacío borrado (${fresco.name})`);
    registrarEvento(fresco.guild, {
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

// ---------- Desactivación del sistema (compartida por /voz desactivar y sus botones) ----------
// borraTemporales=true borra YA todos los temporales y limpia sus registros;
// false conserva el comportamiento clásico: quedan vivos hasta vaciarse.
async function desactivarSistema(guild, { borrarTemporales = false } = {}) {
  const config = vozDe(guild.id);
  const hub = config.hubId ? guild.channels.cache.get(config.hubId) : null;
  if (hub) {
    try {
      await hub.delete('Sistema de canales de voz desactivado');
    } catch (error) {
      log.warn(`No se pudo borrar el hub al desactivar: ${error.message}`);
    }
  }
  setGuildConfig(guild.id, (c) => {
    if (c.voz) delete c.voz.hubId;
  });

  const temporales = Object.keys(temporalesDe(guild.id));
  let borrados = 0;
  if (borrarTemporales) {
    for (const canalId of temporales) {
      cancelarBorrado(canalId);
      olvidarTemporal(guild.id, canalId);
      const canal = guild.channels.cache.get(canalId);
      if (canal) {
        const resultado = await opBorrar(canal, 'Sistema de voz desactivado: limpieza de temporales');
        if (resultado.ok) borrados += 1;
      }
    }
    mutarYAgendar(guild.id, (c) => {
      if (c.voz?.bloqueos) for (const canalId of temporales) delete c.voz.bloqueos[canalId];
    });
  }
  return { total: temporales.length, borrados, hubEliminado: Boolean(hub) };
}

// ---------- Bloqueos con duración (reapertura automática) ----------
// Voz.bloqueosTemporales: Map canalId → vencimiento (ms epoch). Memoria + config:
// al arrancar se restauran los vencimientos futuros y se reabren los vencidos.
// `programarReapertura` es inyectable en tests (reloj falso).
let programarReapertura = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
};

function fijarProgramadorReapertura(fn) {
  programarReapertura = fn;
}

function bloqueosTemporalesDe(guildId) {
  return vozDe(guildId).bloqueos || {};
}

async function bloquearConDuracion(guild, canal, ms, motivo, autorId) {
  const resultado = await opOverwrite(canal, guild.roles.everyone.id, { [PermissionFlagsBits.Connect]: false }, motivo);
  if (!resultado.ok) return resultado;

  const ahora = Date.now();
  const vence = ms > 0 ? ahora + ms : 0; // 0 = indefinido: se persiste y sobrevive reinicios, sin timer
  mutarYAgendar(guild.id, (c) => {
    c.voz = c.voz || {};
    c.voz.bloqueos = c.voz.bloqueos || {};
    c.voz.bloqueos[canal.id] = vence;
  });
  if (vence > 0) {
    // La arrow DEVUELVE la promesa: esperar al callback (tests, reloj falso) espera el trabajo real.
    programarReapertura(
      () =>
        reabrirSiSigueBloqueado(guild, canal.id, vence).catch((error) => log.error('Error al reabrir canal bloqueado', error)),
      vence - ahora
    );
  }
  log.info(`Canal temporal ${canal.id} bloqueado${vence ? ` por ${ms} ms` : ' de forma indefinida'} por ${autorId}`);
  return { ok: true };
}

async function reabrirCanal(guild, canal, { motivo } = {}) {
  const resultado = await opOverwrite(canal, guild.roles.everyone.id, { [PermissionFlagsBits.Connect]: null }, motivo ?? 'Reapertura programada del bloqueo');
  if (!resultado.ok) return resultado;
  mutarYAgendar(guild.id, (c) => {
    if (c.voz?.bloqueos) delete c.voz.bloqueos[canal.id];
  });
  return { ok: true };
}

// El vencimiento disparó: solo reabre si el vencimiento guardado sigue siendo el
// mismo (el dueño pudo re-bloquear con otra duración entre medio).
async function reabrirSiSigueBloqueado(guild, canalId, venceEsperado) {
  const guardado = bloqueosTemporalesDe(guild.id)[canalId];
  if (guardado !== venceEsperado) return; // hubo un bloqueo nuevo: su propio timer se encarga
  const canal = guild.channels.cache.get(canalId);
  if (!canal) {
    mutarYAgendar(guild.id, (c) => {
      if (c.voz?.bloqueos) delete c.voz.bloqueos[canalId];
    });
    return;
  }
  await reabrirCanal(guild, canal);
}

// Al arrancar: los vencidos se reabren de una, los futuros se re-programan.
async function restaurarBloqueos(guild) {
  const bloqueos = bloqueosTemporalesDe(guild.id);
  for (const [canalId, vence] of Object.entries(bloqueos)) {
    const canal = guild.channels.cache.get(canalId);
    if (!canal) {
      mutarYAgendar(guild.id, (c) => {
        if (c.voz?.bloqueos) delete c.voz.bloqueos[canalId];
      });
      continue;
    }
    if (vence === 0) continue; // bloqueo indefinido: sigue bloqueado tras el reinicio, no lleva timer
    if (vence <= Date.now()) {
      await reabrirCanal(guild, canal, { motivo: 'Bloqueo vencido durante el reinicio' }).catch(() => {});
    } else {
      programarReapertura(
        () =>
          reabrirSiSigueBloqueado(guild, canalId, vence).catch((error) => log.error('Error al reabrir canal bloqueado', error)),
        vence - Date.now()
      );
    }
  }
}

// ---------- Núcleo: reacción a cada cambio de voz ----------
async function manejarCambio(oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;

  const config = vozDe(guild.id);
  const hayTemporales = Object.keys(temporalesDe(guild.id)).length > 0;
  if (!config.hubId && !hayTemporales) return;

  // Antigüedad de entrada: se anota cada ingreso a un canal de voz del sistema
  // (hub o temporal) para que nuevoDueno() elija por más antigüedad, no por orden de cache.
  if (newState.channelId && newState.channelId !== oldState.channelId) registrarIngreso(guild.id, newState.id ?? newState.member?.id);

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

  refrescarContador(guild, canal); // entró o salió alguien: el nombre se updatea

  // 3) El dueño se fue pero queda gente: el dueño pasa al humano con más
  //    antigüedad de entrada (criterio determinista: ver "Antigüedad de entrada").
  const duenoId = duenoDe(guild.id, canalId);
  if (duenoId && !canal.members.has(duenoId)) {
    const reemplazo = nuevoDueno(canal);
    if (reemplazo) await transferirA(guild, canal, reemplazo);
  }
}

// ---------- Antigüedad de entrada (para nuevoDueno) ----------
// canal.members es un Map de discord.js y su orden de inserción NO garantiza el
// orden de entrada real (el cache se reconstruye con eventos fuera de orden).
// Solución: instante de entrada por guildId:userId en memoria; si no lo conocemos
// (reinicio), queda el orden del cache como criterio determinista de reserva.
const ingresos = new Map(); // clave guildId:userId → Date.now() del último ingreso a un canal

function registrarIngreso(guildId, userId) {
  ingresos.set(`${guildId}:${userId}`, Date.now());
}

function olvidarIngreso(guildId, userId) {
  ingresos.delete(`${guildId}:${userId}`);
}

// Criterio determinista y documentado: gana el humano que lleva MÁS TIEMPO
// dentro del canal (el primero que entró entre los que quedan). Bots y salidos
// quedan excluidos. Si un humano no tiene instante registrado (reinicio), se
// usa el orden del Map del cache como desempate estable.
function nuevoDueno(canal, { obtenerSello } = {}) {
  const sello = obtenerSello ?? ((guildId, userId) => ingresos.get(`${guildId}:${userId}`) ?? null);
  const guildId = canal.guild?.id ?? canal.guildId ?? '';
  const humanos = [...canal.members.values()].filter((m) => !m.user?.bot);
  if (!humanos.length) return null;
  return humanos.reduce((mejor, miembro) => {
    const tNuevo = sello(guildId, miembro.id);
    const tMejor = sello(guildId, mejor.id);
    if (tNuevo === null) return mejor; // sin dato: gana el que ya tiene sello; si ninguno, el orden del cache
    if (tMejor === null) return miembro;
    return tNuevo < tMejor ? miembro : mejor;
  }, humanos[0]);
}

// ---------- Controles (botones, selects y modales del panel) ----------
function opcionMiembros(canal, { excluir = [] } = {}) {
  return [...canal.members.values()]
    .filter((m) => !m.user?.bot && !excluir.includes(m.id))
    .slice(0, 25) // límite de opciones de Discord
    .map((m) => ({ label: m.displayName.slice(0, 100), value: m.id }));
}

// Selector de miembros del server (permitir/bloquear): hasta 25 opciones, sin bots.
function opcionServidor(guild, { excluir = [] } = {}) {
  return [...guild.members.cache.values()]
    .filter((m) => !m.user?.bot && !excluir.includes(m.id))
    .slice(0, 25)
    .map((m) => ({ label: m.displayName.slice(0, 100), value: m.id }));
}

// Duraciones del cierre programado (ms) para el select de "Ajustes".
const DURACIONES_CIERRE = [
  { etiqueta: '5 minutos', value: '5' },
  { etiqueta: '15 minutos', value: '15' },
  { etiqueta: '1 hora', value: '60' },
  { etiqueta: 'Indefinido', value: '0' },
];

const BITRATES_OPCIONES = ['64000', '80000', '96000', '128000', '256000', 'auto'];

function menuAvanzado(canal) {
  void canal; // las opciones no dependen del estado del canal (misma para todos)
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('voz:sel:avanzado')
      .setPlaceholder('Cerrar por tiempo, bitrate o región')
      .addOptions([
        ...DURACIONES_CIERRE.map((d) => ({ label: `⏱️ Cerrar por ${d.etiqueta}`, value: `cierre:${d.value}` })),
        ...BITRATES_OPCIONES.map((b) => ({
          label: b === 'auto' ? 'Bitrate automático' : `Bitrate ${Number(b) / 1000} kbps`,
          value: `bitrate:${b}`,
        })),
        { label: 'Región automática', value: 'region:auto' },
        ...['brazil', 'us-east', 'europe'].map((r) => ({ label: `Región ${r}`, value: `region:${r}` })),
      ])
  );
}

async function manejarComponente(interaction) {
  const accion = interaction.customId.split(':')[1];
  const guild = interaction.guild;
  const canal = interaction.channel;

  // Desactivación del sistema (botones de confirmación de /voz desactivar):
  // se maneja ANTES del chequeo de canal temporal, porque se hace desde donde
  // el staff ejecutó el comando (no necesariamente un canal temporal).
  if (accion === 'admin') {
    const subaccion = interaction.customId.split(':')[2]; // desactivar_borrar | desactivar_conservar
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ content: 'Solo el staff puede confirmar esta acción.', flags: MessageFlags.Ephemeral });
    }
    if (subaccion === 'desactivar_conservar') {
      const res = await desactivarSistema(guild, { borrarTemporales: false });
      return interaction.update({
        embeds: [
          successEmbed(
            `Sistema desactivado. Se conservan los ${res.total} canal(es) temporales: se borran solos cuando queden vacíos.`
          ),
        ],
        components: [],
      });
    }
    if (subaccion === 'desactivar_borrar') {
      await interaction.deferUpdate();
      const res = await desactivarSistema(guild, { borrarTemporales: true });
      return interaction.editReply({
        embeds: [successEmbed(`Sistema desactivado. 🗑️ Se borraron **${res.borrados} de ${res.total}** canal(es) temporales y sus registros.`)],
        components: [],
      });
    }
    return interaction.reply({ content: 'Acción desconocida.', flags: MessageFlags.Ephemeral });
  }

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

  if (!puedeControlar(guild, interaction.member, duenoId)) {
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

    case 'lock': {
      await interaction.deferUpdate();
      const resultado = await opOverwrite(canal, guild.roles.everyone.id, { [PermissionFlagsBits.Connect]: false }, 'Cierre manual del canal temporal');
      if (!resultado.ok) {
        return interaction.followUp({ content: `⚠️ Discord rechazó el cierre: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
      }
      mutarYAgendar(guild.id, (c) => {
        c.voz = c.voz || {};
        c.voz.bloqueos = c.voz.bloqueos || {};
        c.voz.bloqueos[canal.id] = 0; // cierre manual: indefinido, sobrevive reinicios
      });
      return interaction.followUp({ content: '🔒 Canal **cerrado**: solo pueden entrar quienes ya están adentro.', flags: MessageFlags.Ephemeral });
    }

    case 'unlock': {
      await interaction.deferUpdate();
      const resultado = await reabrirCanal(guild, canal, { motivo: 'Apertura manual del canal temporal' });
      if (!resultado.ok) {
        return interaction.followUp({ content: `⚠️ Discord rechazó la apertura: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
      }
      return interaction.followUp({ content: '🔓 Canal **abierto** para todos.', flags: MessageFlags.Ephemeral });
    }

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

    case 'permitir':
    case 'bloquear': {
      const opciones = opcionServidor(guild, { excluir: [interaction.user.id] });
      if (!opciones.length) {
        return interaction.reply({ content: 'No encontré otros miembros para elegir.', flags: MessageFlags.Ephemeral });
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`voz:sel:${accion}`)
        .setPlaceholder(accion === 'permitir' ? 'Elegí a quién permitir' : 'Elegí a quién bloquear')
        .addOptions(opciones);
      return interaction.reply({
        content: accion === 'permitir' ? '➕ Elegí al usuario a permitir:' : '🚫 Elegí al usuario a bloquear:',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
    }

    case 'avanzado': {
      return interaction.reply({
        content: '⚙️ Ajustes del canal: cierre temporizado, bitrate y región.',
        components: [menuAvanzado(canal)],
        flags: MessageFlags.Ephemeral,
      });
    }

    case 'borrar': {
      await interaction.deferUpdate();
      const resultado = await opBorrar(canal, `Dueño cerró su canal temporal (${interaction.user.tag})`);
      if (!resultado.ok) {
        return interaction.followUp({ content: `⚠️ Discord rechazó el borrado: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
      }
      olvidarTemporal(guild.id, canal.id); // solo si Discord aceptó: si no, el canal seguiría vivo y huérfano
      logEvent(guild, {
        color: 0xed4245,
        title: '🗑️ Canal de voz temporal borrado',
        description: `**${canal.name}** (de <@${duenoId}>) fue cerrado por <@${interaction.user.id}>.`,
      });
      return;
    }

    default:
      return interaction.reply({ content: 'Acción desconocida.', flags: MessageFlags.Ephemeral });
  }
}

// Selects del panel (expulsar / transferir / permitir / bloquear / avanzado).
async function manejarSelect(interaction) {
  const [, , tipo] = interaction.customId.split(':'); // voz:sel:kick|transferir|permitir|bloquear|avanzado
  const guild = interaction.guild;
  const canal = interaction.channel;
  if (!guild || !canal || !esTemporal(guild.id, canal.id)) {
    return interaction.update({ content: 'Este canal ya no existe.', components: [] });
  }
  const duenoId = duenoDe(guild.id, canal.id);
  const objetivo = guild.members.cache.get(interaction.values[0]);
  await interaction.deferUpdate();

  // REVALIDACIÓN tras deferUpdate: entre que se abrió el menú y se eligió una
  // opción pueden cambiar las cosas. Se vuelve a comprobar que quien eligió
  // SIGA siendo dueño (o staff) y que el canal SIGA siendo un temporal.
  if (!esTemporal(guild.id, canal.id) || !puedeControlar(guild, interaction.member, duenoDe(guild.id, canal.id))) {
    return interaction.followUp({ content: '⚠️ Tus permisos sobre este canal cambiaron: la acción no se ejecutó.', flags: MessageFlags.Ephemeral });
  }

  // Opciones avanzadas: cierre temporizado, bitrate y región.
  if (tipo === 'avanzado') {
    const [categoriaValor, valor] = (interaction.values[0] ?? '').split(':');
    if (categoriaValor === 'cierre') {
      const minutos = Number(valor);
      if (!Number.isFinite(minutos) || minutos < 0) {
        return interaction.followUp({ content: 'Duración inválida.', flags: MessageFlags.Ephemeral });
      }
      const ms = minutos * 60_000;
      const resultado = await bloquearConDuracion(guild, canal, ms, `Cierre temporizado por ${interaction.user.tag}`, interaction.user.id);
      if (!resultado.ok) {
        return interaction.followUp({ content: `⚠️ Discord rechazó el cierre: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
      }
      const texto = ms === 0 ? '🔒 Canal **cerrado indefinidamente**.' : `🔒 Canal **cerrado por ${minutos === 60 ? '1 hora' : `${minutos} minutos`}**. Se reabre solo.`;
      return interaction.followUp({ content: texto, flags: MessageFlags.Ephemeral });
    }

    if (categoriaValor === 'bitrate') {
      if (valor === 'auto') {
        const resultado = await opBitrate(canal, 0, `Bitrate automático por ${interaction.user.tag}`);
        if (!resultado.ok) return interaction.followUp({ content: `⚠️ Discord rechazó el cambio: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
        return interaction.followUp({ content: '🎚️ Bitrate volvió al **automático del server**.', flags: MessageFlags.Ephemeral });
      }
      const bps = bitrateValido(valor);
      if (!bps) return interaction.followUp({ content: 'Bitrate inválido.', flags: MessageFlags.Ephemeral });
      const resultado = await opBitrate(canal, bps, `Bitrate ajustado por ${interaction.user.tag}`);
      if (!resultado.ok) {
        return interaction.followUp({
          content: `⚠️ Discord rechazó el bitrate de ${bps / 1000} kbps (¿faltan boosts?): \`${resultado.error}\``,
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.followUp({ content: `🎚️ Bitrate fijado en **${bps / 1000} kbps**.`, flags: MessageFlags.Ephemeral });
    }

    if (categoriaValor === 'region') {
      const region = regionValida(valor);
      if (region === undefined) return interaction.followUp({ content: 'Región inválida.', flags: MessageFlags.Ephemeral });
      const resultado = await opRegion(canal, region, `Región ajustada por ${interaction.user.tag}`);
      if (!resultado.ok) {
        return interaction.followUp({ content: `⚠️ Discord rechazó la región: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
      }
      return interaction.followUp({ content: region ? `🌍 Región fijada en **${region}**.` : '🌍 Región volvió al **automático**.', flags: MessageFlags.Ephemeral });
    }

    return interaction.followUp({ content: 'Opción desconocida.', flags: MessageFlags.Ephemeral });
  }

  if (!objetivo) {
    return interaction.followUp({ content: 'Ese usuario ya no está en el servidor.', flags: MessageFlags.Ephemeral });
  }
  // Solo expulsar y transferir exigen que el objetivo esté adentro: permitir/
  // bloquear apuntan justamente a gente que NO está en el canal todavía.
  if ((tipo === 'kick' || tipo === 'transferir') && !canal.members.has(objetivo.id)) {
    return interaction.followUp({ content: 'Ese usuario ya no está en el canal.', flags: MessageFlags.Ephemeral });
  }

  if (tipo === 'kick') {
    if (objetivo.id === duenoId) {
      return interaction.followUp({ content: 'No podés expulsar al dueño; transfirele el canal primero.', flags: MessageFlags.Ephemeral });
    }
    const resultado = await opDisconnect(objetivo, `Expulsado del canal temporal por ${interaction.user.tag}`);
    if (!resultado.ok) {
      return interaction.followUp({ content: `⚠️ Discord rechazó la expulsión de **${objetivo.displayName}**: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
    }
    return interaction.followUp({ content: `👢 Expulsaste a **${objetivo.displayName}** del canal.`, flags: MessageFlags.Ephemeral });
  }

  if (tipo === 'transferir') {
    await transferirA(guild, canal, objetivo);
    return interaction.followUp({ content: `👑 **${objetivo.displayName}** ahora es el dueño del canal.`, flags: MessageFlags.Ephemeral });
  }

  if (tipo === 'permitir' || tipo === 'bloquear') {
    if (objetivo.id === duenoId) {
      return interaction.followUp({ content: `No podés ${tipo === 'permitir' ? 'modificar los permisos' : 'bloquear'} al dueño del canal.`, flags: MessageFlags.Ephemeral });
    }
    if (objetivo.id === interaction.client?.user?.id) {
      return interaction.followUp({ content: 'No podés bloquear al bot: necesita entrar para funcionar.', flags: MessageFlags.Ephemeral });
    }
    const yaBloqueado = estaBloqueado(canal, objetivo.id);
    if (tipo === 'bloquear' && yaBloqueado) {
      return interaction.followUp({ content: `**${objetivo.displayName}** ya está bloqueado.`, flags: MessageFlags.Ephemeral });
    }
    const permisos =
      tipo === 'permitir'
        ? { [PermissionFlagsBits.Connect]: true, [PermissionFlagsBits.ViewChannel]: true, [PermissionFlagsBits.SendMessages]: true }
        : { [PermissionFlagsBits.Connect]: false, [PermissionFlagsBits.ViewChannel]: null };
    const resultado = await opOverwrite(
      canal,
      objetivo.id,
      permisos,
      `${tipo === 'permitir' ? 'Permitido' : 'Bloqueado'} en canal temporal por ${interaction.user.tag}`
    );
    if (!resultado.ok) {
      return interaction.followUp({ content: `⚠️ Discord rechazó el cambio de permisos: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
    }
    // Bloqueado con voz puesta: lo saca del canal para que el bloqueo aplique ya.
    if (tipo === 'bloquear' && canal.members.has(objetivo.id)) {
      await opDisconnect(objetivo, `Bloqueado del canal temporal por ${interaction.user.tag}`);
    }
    return interaction.followUp({
      content:
        tipo === 'permitir'
          ? `➕ **${objetivo.displayName}** ya puede entrar al canal (aunque esté cerrado).`
          : `🚫 **${objetivo.displayName}** quedó bloqueado: no puede entrar${canal.members.has(objetivo.id) ? '' : ' y si estaba adentro fue expulsado'}.`,
      flags: MessageFlags.Ephemeral,
    });
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
  if (!puedeControlar(guild, interaction.member, duenoDe(guild.id, canal.id))) {
    return interaction.reply({ content: 'Solo el dueño del canal (o el staff) puede usar estos controles.', flags: MessageFlags.Ephemeral });
  }

  if (tipo === 'nombre') {
    const nombre = interaction.fields.getTextInputValue('nombre').trim().slice(0, 90);
    if (!nombre) return interaction.reply({ content: 'El nombre no puede quedar vacío.', flags: MessageFlags.Ephemeral });
    const resultado = await opRename(canal, nombre, `Renombrado por ${interaction.user.tag}`);
    if (!resultado.ok) {
      return interaction.reply({ content: `⚠️ Discord rechazó el renombre: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
    }
    refrescarContador(guild, canal); // vuelve a colgarle el contador al nombre nuevo
    return interaction.reply({ content: `📝 Canal renombrado a **${nombre}**.`, flags: MessageFlags.Ephemeral });
  }

  if (tipo === 'limite') {
    const limite = limiteValido(interaction.fields.getTextInputValue('limite'));
    if (limite === null) return interaction.reply({ content: 'Límite inválido: usá un número de 0 a 99 (0 = sin límite).', flags: MessageFlags.Ephemeral });
    const resultado = await opLimite(canal, limite, `Límite ajustado por ${interaction.user.tag}`);
    if (!resultado.ok) {
      return interaction.reply({ content: `⚠️ Discord rechazó el cambio de límite: \`${resultado.error}\``, flags: MessageFlags.Ephemeral });
    }
    refrescarContador(guild, canal); // con límite el contador pasa a mostrarse como «n/límite»
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
        const resultado = await opBorrar(canal, 'Limpieza al arrancar: canal temporal vacío');
        if (!resultado.ok) continue;
        registrarEvento(guild, {
          color: 0xed4245,
          title: '🗑️ Canal de voz temporal borrado',
          description: `**${canal.name}** (de <@${duenoId}>) quedó vacío tras un reinicio y se limpió.`,
        });
      }
    }
    await restaurarBloqueos(guild).catch((error) => log.error('Error restaurando bloqueos temporales', error));
  }
}

module.exports = {
  NOMBRE_HUB,
  PLANTILLA_NOMBRE,
  nombreCanal,
  nombreConContador,
  nombreBaseDe,
  bitrateValido,
  regionValida,
  limiteCanalesValido,
  vozDe,
  temporalesDe,
  categoriaDe,
  nivelEventos,
  contadorActivo,
  limiteValido,
  limiteCanales,
  fallbackActivo,
  nuevoDueno,
  esTemporal,
  duenoDe,
  canalDeDueno,
  registrarTemporal,
  olvidarTemporal,
  registrarIngreso,
  olvidarIngreso,
  moverTemporalesACategoria,
  manejarCambio,
  refrescarContador,
  manejarComponente,
  manejarSelect,
  manejarModal,
  limpiarAlArrancar,
  desactivarSistema,
  fijarProgramadorReapertura,
  bloquearConDuracion,
  reabrirCanal,
  restaurarBloqueos,
  permitidosDe,
  estaBloqueado,
  puedeControlar,
  esStaffMiembro,
  PERMISOS_DUENO,
  PERMISOS_CHAT_DUENO,
};
