const { Events } = require('discord.js');
const { responderCharla, respuestaInstantanea, normalizar } = require('../utils/charla');
const { conversar, trocearMensaje, perfilDe } = require('../utils/ia');
const { decidirBusqueda, respuestaSinIA } = require('../utils/web');
const { pedirConfirmacion } = require('../utils/accionesIA');
const { DUENO_ID } = require('../comunidad');
const { getAFK, quitarAFK } = require('../commands/afk');
const { procesarMensaje, datosDe, xpParaNivel, canalAnuncios, rangoDe, XP_MIN, XP_MAX, LOGROS } = require('../niveles');
const { asignarRolesNivel } = require('../utils/rolesNivel');
const { brandEmbed, COLORS, miles } = require('../utils/replies');
const { getGuildConfig } = require('../store');
const { procesarMensajeParaSpam, procesarMensajeParaFiltros } = require('../utils/proteccion');

// Limita el tamaño del buffer de mensajes recientes por canal para no crecer sin control.
const MAX_BUFFER = 100;

// Cooldown de charla: 1 respuesta por usuario cada 3 segundos (spam friendly).
const COOLDOWN_MS = 3_000;
const cooldowns = new Map();

function clave(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

// Guarda el mensaje en el buffer para poder mostrar su contenido en los logs de borrados/ediciones.
function guardarEnBuffer(message) {
  const config = getGuildConfig(message.guild.id);
  if (!config.logs && !config.modlog) return; // nada de logging configurado

  const key = clave(message.guild.id, message.channelId);
  const canal = message.client.buffersMensajes.get(key);
  const registro = {
    contenido: message.content,
    autorId: message.author.id,
    // Nombre de usuario (no el tag: Discord ya no garantiza discriminadores).
    autorNombre: message.author.username ?? message.author.tag,
  };
  if (canal) {
    canal.set(message.id, registro);
    if (canal.size > MAX_BUFFER) {
      const first = canal.keys().next().value;
      canal.delete(first);
    }
  } else {
    message.client.buffersMensajes.set(key, new Map([[message.id, registro]]));
  }
}

// Devuelve true si el usuario está dentro del cooldown; si no, registra el intento.
function estaEnCooldown(userId) {
  const ahora = Date.now();
  const ultima = cooldowns.get(userId) ?? 0;
  if (ahora - ultima < COOLDOWN_MS) return true;
  cooldowns.set(userId, ahora);
  if (cooldowns.size > 500) {
    for (const [id, ts] of cooldowns) {
      if (ahora - ts >= COOLDOWN_MS) cooldowns.delete(id);
    }
  }
  return false;
}

// ---------- Anuncios de niveles: un solo mensaje de texto por evento ----------
// Antes: un embed por logro más el de la subida (una subida con 3 logros nuevos eran
// 4 mensajes). Ahora todo lo que pasó se cuenta UNA vez y en UN mensaje, en líneas
// cortas: qué pasó y con cuánta XP, dónde quedó parado, logros, rol ganado y cambio de
// rango. Las líneas que no aplican no se agregan, así el mensaje queda corto cuando
// pasó una sola cosa.

// XP base promedio de un mensaje (sin bonus): traduce "faltan 1.544 XP" a algo
// comparable, como "~78 mensajes".
const XP_PROMEDIO = (XP_MIN + XP_MAX) / 2;

// Arma el texto del anuncio. Separado de anunciarProgreso para poder probarlo sin
// Discord de por medio.
function textoProgreso(message, progreso, rolesOtorgados = []) {
  const datos = datosDe(message.guild.id, message.author.id);
  const lineas = [];
  const salto = progreso.nivelNuevo - progreso.nivelAnterior > 1;

  // 1) Qué pasó, con la XP que lo causó y el bonus que la explica.
  const bonus = [];
  if (progreso.detalle?.finde) bonus.push('x2 finde');
  if (progreso.detalle?.noche) bonus.push('+10% noche');
  if (progreso.detalle?.bonoRacha) bonus.push(`+${progreso.detalle.bonoRacha}% racha`);
  const conBonus = bonus.length ? ` (${bonus.join(' · ')})` : '';

  if (progreso.subio) {
    const rango = rangoDe(progreso.nivelNuevo);
    const cuanto = salto ? `del nivel **${progreso.nivelAnterior}** al **${progreso.nivelNuevo}**` : `al nivel **${progreso.nivelNuevo}**`;
    lineas.push(`${message.author} subió ${cuanto} (${rango.nombre}) · +${miles(progreso.xpGanado)} XP${conBonus}`);
  } else {
    const cuantos = progreso.logrosNuevos.length;
    lineas.push(`${message.author} desbloqueó ${cuantos === 1 ? 'un logro nuevo' : `${cuantos} logros nuevos`}`);
  }

  // 2) Dónde quedó parado.
  if (progreso.subio) {
    const faltan = Math.max(xpParaNivel(progreso.nivelNuevo + 1) - datos.xp, 0);
    const mensajes = Math.ceil(faltan / XP_PROMEDIO);
    lineas.push(`**${miles(datos.xp)} XP** · faltan **${miles(faltan)}** para el nivel ${progreso.nivelNuevo + 1} (~${miles(mensajes)} mensajes)`);
  } else {
    lineas.push(`**${miles(datos.xp)} XP** en total · ${datos.logros?.length ?? 0}/${LOGROS.length} logros`);
  }

  // 3) Logros nuevos, agrupados en una línea con lo que pagó cada uno.
  if (progreso.logrosNuevos.length) {
    const lista = progreso.logrosNuevos.map((l) => `**${l.nombre}** +${miles(l.premio || 0)} XP`).join(' · ');
    lineas.push(`Logros: ${lista}`);
  }

  // 4) Rol(es) ganados: la recompensa configurable del servidor, que antes era invisible.
  if (rolesOtorgados.length) {
    lineas.push(`Rol: ${rolesOtorgados.map((r) => `**${r.nombre}**`).join(', ')}`);
  }

  // 5) Cambio de rango: el hito que la gente nota, antes escondido entre paréntesis.
  const rangoAntes = rangoDe(progreso.nivelAnterior ?? 0);
  const rangoAhora = rangoDe(progreso.nivelNuevo);
  if (progreso.subio && rangoAntes.nombre !== rangoAhora.nombre) {
    lineas.push(`Nuevo rango: **${rangoAntes.nombre} → ${rangoAhora.nombre}**`);
  }

  return lineas.join('\n');
}

// Manda el anuncio en el canal configurado (si existe y si hubo algo que contar).
async function anunciarProgreso(message, progreso, rolesOtorgados = []) {
  if (!progreso.subio && progreso.logrosNuevos.length === 0) return;

  const canalId = canalAnuncios(message.guild.id);
  if (!canalId) return;
  const canal = message.guild.channels.cache.get(canalId);
  if (!canal) return;

  await canal.send({ content: textoProgreso(message, progreso, rolesOtorgados) }).catch(() => {});
}

// Responde cuando alguien menciona al bot: siempre contesta con un mensaje.
async function manejarMencion(message) {
  const client = message.client;
  if (!message.mentions.users.has(client.user.id)) return;

  // Si el staff apagó la IA en este servidor, el bot ignora las menciones.
  if (getGuildConfig(message.guild.id).iaActivada === false) return;

  if (estaEnCooldown(message.author.id)) return;

  // Texto que quedó después de la mención: "@TriggerBOT hola" → "hola"
  const texto = normalizar(message.content.replaceAll(`<@${client.user.id}>`, '').replaceAll(`<@!${client.user.id}>`, '').trim());

  // Ping rápido con formato del bot; el resto es charla o acciones con IA.
  if (texto === 'ping') {
    const embed = brandEmbed({
      color: COLORS.success,
      title: 'Pong!',
      description: `**Latencia de la API:** ${Math.round(client.ws.ping)}ms\nPara más detalle usá /ping.`,
    });
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  // Respuestas instantáneas (0 ms): identidad, quién creó el bot, links oficiales.
  const instantanea = respuestaInstantanea(texto);
  if (instantanea) return message.reply({ content: instantanea }).catch(() => {});

  // Si el mensaje también menciona al dueño, la IA lo sabe por el contexto.
  const mencionaAlDueno = message.mentions.users.has(DUENO_ID);

  // Indicador de "escribiendo" mientras la IA piensa.
  await message.channel.sendTyping().catch(() => {});

  // Chat con IA si está configurada; si falla o no hay clave, respaldo local.
  try {
    const respuesta = await conversar(message.author.id, texto || '(el usuario solo te mencionó)', {
      usuario: message.member?.displayName || message.author.username,
      canal: message.channel.name,
      dueñoPresente: mencionaAlDueno,
      // Contexto en vivo (utils/contexto.js): ficha del autor, servidores CS, config
      // y catálogo real de comandos. Sin esto la IA responde a ciegas.
      guild: message.guild,
      miembro: message.member,
      client,
    });

    if (respuesta?.tipo === 'accion') {
      return pedirConfirmacion(message, respuesta);
    }
    if (respuesta?.tipo === 'chat' && respuesta.texto) {
      // Respuesta larga: se parte en varios mensajes sin cortar palabras al medio.
      const trozos = trocearMensaje(respuesta.texto);
      await message.reply({ content: trozos[0] }).catch(() => {});
      for (const resto of trozos.slice(1)) {
        await message.channel.send({ content: resto }).catch(() => {});
      }
      return;
    }
  } catch (error) {
    console.warn(`[TriggerBOT] IA no disponible, uso respuesta local: ${error.message}`);
  }

  // Sin IA (no hay claves o se cayeron todos los proveedores) una pregunta de cultura
  // general todavía se puede contestar: se busca en la web y se cita la fuente. Antes
  // esto caía en el repertorio local, que solo sabe decir que no entendió.
  try {
    if (decidirBusqueda(texto, { perfil: perfilDe(texto) }).buscar) {
      const directa = await respuestaSinIA(texto, { usuarioId: message.author.id });
      if (directa) return message.reply({ content: directa }).catch(() => {});
    }
  } catch (error) {
    console.warn(`[TriggerBOT] búsqueda web sin IA falló: ${error.message}`);
  }

  await message.reply({ content: responderCharla(texto) }).catch(() => {});
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message.guild || message.author?.bot) return;

    // Automod: invitaciones, enlaces, menciones masivas, mayúsculas y repetidos.
    // Va antes del anti-spam: un mensaje filtrado no se cuenta ni se responde.
    try {
      if (await procesarMensajeParaFiltros(message)) return;
    } catch (error) {
      console.error('[TriggerBOT] Error en el automod:', error.message);
    }

    // Anti-spam: si tomó una acción, no se suma XP ni se responde por el burst.
    try {
      const accion = await procesarMensajeParaSpam(message);
      if (accion) return;
    } catch (error) {
      console.error('[TriggerBOT] Error en anti-spam:', error.message);
    }

    guardarEnBuffer(message);

    // Sistema de niveles: XP, logros, anuncios y roles por nivel.
    try {
      const progreso = procesarMensaje(message.guild.id, message.author.id);
      // Los roles primero: el anuncio cuenta cuál se otorgó (antes se asignaban
      // después, así que la recompensa nunca se podía nombrar).
      let rolesOtorgados = [];
      if (progreso.subio || progreso.logrosNuevos.length) {
        rolesOtorgados = await asignarRolesNivel(message.member, progreso.nivelNuevo);
      }
      await anunciarProgreso(message, progreso, rolesOtorgados);
    } catch (error) {
      console.error('[TriggerBOT] Error procesando niveles:', error.message);
    }

    // Si el usuario estaba AFK y volvió a hablar, se le saca la marca.
    if (getAFK(message.guild.id, message.author.id)) {
      quitarAFK(message.guildId ?? message.guild.id, message.author.id);
      await message.reply('Bienvenido de vuelta, te saqué la marca AFK.').catch(() => {});
    }

    // Si el mensaje menciona a alguien AFK, se avisa.
    for (const [userId] of message.mentions.users) {
      if (userId === message.author.id) continue;
      const afk = getAFK(message.guild.id, userId);
      if (afk) {
        const minutos = Math.floor((Date.now() - afk.desde) / 60000);
        const tiempo = minutos >= 60 ? `${Math.floor(minutos / 60)} h` : `${Math.max(minutos, 1)} min`;
        await message
          .reply(`**${message.guild.members.cache.get(userId)?.displayName || 'Ese usuario'}** está AFK desde hace ${tiempo}: ${afk.motivo}`)
          .catch(() => {});
        break; // un solo aviso por mensaje
      }
    }

    await manejarMencion(message);
  },

  // Exportados para los tests: armar el texto no necesita Discord, solo el fake.
  textoProgreso,
  anunciarProgreso,
};
