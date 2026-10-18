// Sorteos comunitarios: el staff publica un panel con /sorteo crear y la comunidad
// participa con los botones. El estado vive en la config del servidor (`c.sorteos`),
// igual que los tempbans: sobrevive reinicios y viaja con el respaldo de MariaDB.
//
// Decisiones que importan:
//   · El sorteo se cierra solo: `procesar()` (la llama index.js cada 30 s) finaliza los
//     vencidos, edita el panel para que deje de invitar a participar y anuncia a los
//     ganadores. Si el bot estuvo caído, el primer pase los cierra igual.
//   · Nada se informa como hecho si no pasó: el estado cambia recién cuando hay una
//     decisión real, y los errores de Discord (permisos, mensaje borrado) se registran
//     sin tumbar la pasada.
//   · Una persona participa una sola vez y puede salir: el botón nunca duplica entradas.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { getGuildConfig, setGuildConfig, mutarYAgendar } = require('../store');
const { brandEmbed, COLORS, marcaTiempo, miles } = require('./replies');
const crearLogger = require('../logger');

const log = crearLogger('sorteos');

const DURACION_MINIMA_MS = 60_000; // 1 minuto
const DURACION_MAXIMA_MS = 30 * 86400_000; // 30 días
const MAX_GANADORES = 10;
const MAX_PARTICIPANTES = 5_000; // tope de almacenamiento por sorteo
const MAX_ABIERTOS = 5; // sorteos abiertos a la vez por servidor
const MAX_GUARDADOS = 50; // historial de sorteos cerrados que se conserva
const MAX_PREMIO = 200;

const ESTADOS = {
  abierto: 'abierto',
  finalizado: 'finalizado',
  cancelado: 'cancelado',
};

// "30m" | "12h" | "7d" | "45s" → milisegundos. Sin unidad se asume minutos.
// Fuera del rango (1 min a 30 días) devuelve null: el comando avisa el rango en vez de
// recortar la duración en silencio.
function parsearDuracion(texto) {
  const limpio = String(texto ?? '')
    .trim()
    .toLowerCase();
  if (!limpio) return null;
  const partes = limpio.match(/^(\d{1,4})\s*(s|seg|segs|m|min|mins|h|hs|hora|horas|d|dia|dias|días)?$/);
  if (!partes) return null;
  const cantidad = Number(partes[1]);
  if (!Number.isFinite(cantidad) || cantidad <= 0) return null;

  const unidad = partes[2] ?? 'm';
  const factor = unidad.startsWith('s') ? 1000 : unidad.startsWith('h') ? 3600_000 : unidad.startsWith('d') ? 86400_000 : 60_000;
  const ms = cantidad * factor;
  return ms < DURACION_MINIMA_MS || ms > DURACION_MAXIMA_MS ? null : ms;
}

// Los sorteos de un servidor (siempre un array, nunca undefined).
function lista(guildId) {
  const guardados = getGuildConfig(guildId).sorteos;
  return Array.isArray(guardados) ? guardados : [];
}

function abiertos(guildId) {
  return lista(guildId).filter((s) => s.estado === ESTADOS.abierto);
}

// Sorteo por número (el mismo que se muestra en el panel y en /sorteo lista).
function obtener(guildId, id) {
  const numero = Number(id);
  if (!Number.isFinite(numero)) return null;
  return lista(guildId).find((s) => s.id === numero) ?? null;
}

// Mutación de un sorteo puntual. Devuelve el sorteo actualizado o null si no existe.
// `diferido` agrupa la escritura a disco: las entradas y salidas pueden llegar en ráfaga.
function actualizar(guildId, id, updater, { diferido = false } = {}) {
  const numero = Number(id);
  let resultado = null;
  const mutar = (c) => {
    const sorteo = (c.sorteos ?? []).find((s) => s.id === numero);
    if (!sorteo) return;
    updater(sorteo);
    resultado = sorteo;
  };
  if (diferido) mutarYAgendar(guildId, mutar);
  else setGuildConfig(guildId, mutar);
  return resultado;
}

// Crea un sorteo. La validación vive acá (y no solo en el comando) para que cualquier
// llamador futuro —el puente de la web, por ejemplo— respete los mismos límites.
function crear(
  guildId,
  { premio, hasta, ganadores = 1, rolId = null, canalId = null, mensajeId = null, creadorId = null, ahora = Date.now() } = {}
) {
  const texto = String(premio ?? '').trim();
  if (!texto) return { error: 'El premio no puede estar vacío.' };
  if (texto.length > MAX_PREMIO) return { error: `El premio no puede pasar de ${MAX_PREMIO} caracteres.` };

  const momento = Number(hasta);
  if (!Number.isFinite(momento)) return { error: 'La duración del sorteo no es válida.' };
  if (momento <= ahora) return { error: 'La duración tiene que ser de al menos 1 minuto.' };
  if (momento - ahora > DURACION_MAXIMA_MS) return { error: 'La duración máxima de un sorteo es de 30 días.' };

  const cantidad = Math.min(Math.max(Number(ganadores) || 1, 1), MAX_GANADORES);
  const yaAbiertos = abiertos(guildId).length;
  if (yaAbiertos >= MAX_ABIERTOS) {
    return { error: `Ya hay ${MAX_ABIERTOS} sorteos abiertos. Terminá o cancelá uno antes de crear otro.` };
  }

  let nuevo = null;
  setGuildConfig(guildId, (c) => {
    const secuencia = Number(c.sorteoSeq) || 0;
    const id = secuencia + 1;
    c.sorteoSeq = id;

    nuevo = {
      id,
      premio: texto,
      creadorId,
      canalId,
      mensajeId,
      hasta: momento,
      ganadores: cantidad,
      rolId: rolId || null,
      estado: ESTADOS.abierto,
      participantes: [],
      ganadoresElegidos: [],
      creado: ahora,
      cerrado: null,
      rerolls: 0,
    };

    const anteriores = (Array.isArray(c.sorteos) ? c.sorteos : []).filter((s) => s.estado !== ESTADOS.abierto);
    const abiertosAhora = (Array.isArray(c.sorteos) ? c.sorteos : []).filter((s) => s.estado === ESTADOS.abierto);
    // El historial no crece sin control, pero un sorteo abierto nunca se descarta.
    c.sorteos = [...anteriores.slice(-MAX_GUARDADOS), ...abiertosAhora, nuevo].sort((a, b) => a.id - b.id);
  });

  return { sorteo: nuevo };
}

// Guarda el mensaje del panel (el id recién se conoce después de publicarlo).
function adjuntarMensaje(guildId, id, mensajeId) {
  return actualizar(guildId, id, (sorteo) => {
    sorteo.mensajeId = mensajeId ? String(mensajeId) : null;
  });
}

// ¿Puede participar esta persona? Devuelve null si sí, o el motivo en texto.
function motivoNoParticipa(sorteo, member, { ahora = Date.now() } = {}) {
  if (!sorteo) return 'Ese sorteo no existe (puede que se haya borrado el panel).';
  if (sorteo.estado === ESTADOS.cancelado) return 'Este sorteo fue cancelado.';
  if (sorteo.estado === ESTADOS.finalizado) return 'Este sorteo ya terminó.';
  if (ahora >= sorteo.hasta) return 'Este sorteo ya cerró: el resultado sale en instantes.';
  if (sorteo.rolId && !member?.roles?.cache?.has?.(sorteo.rolId)) {
    return `Para participar necesitás el rol <@&${sorteo.rolId}>.`;
  }
  return null;
}

// Suma a una persona al sorteo. `estado` dice qué pasó, para que el botón responda
// exactamente eso (nunca "¡listo!" si no entró).
function entrar(guildId, id, member) {
  const sorteo = obtener(guildId, id);
  const motivo = motivoNoParticipa(sorteo, member);
  if (motivo) return { error: motivo };
  if (!member?.id) return { error: 'No pude identificar tu usuario.' };

  if (sorteo.participantes.includes(member.id)) {
    return { yaEstaba: true, sorteo };
  }
  if (sorteo.participantes.length >= MAX_PARTICIPANTES) {
    return { error: 'Este sorteo llegó al máximo de participantes.' };
  }

  const actualizado = actualizar(
    guildId,
    id,
    (s) => {
      if (!s.participantes.includes(member.id)) s.participantes.push(member.id);
    },
    { diferido: true }
  );
  return { sorteo: actualizado ?? sorteo };
}

// Saca a una persona del sorteo (deshacer el botón de participar).
function salir(guildId, id, member) {
  const sorteo = obtener(guildId, id);
  const motivo = motivoNoParticipa(sorteo, member);
  if (motivo) return { error: motivo };
  if (!member?.id) return { error: 'No pude identificar tu usuario.' };
  if (!sorteo.participantes.includes(member.id)) return { noEstaba: true, sorteo };

  const actualizado = actualizar(
    guildId,
    id,
    (s) => {
      s.participantes = s.participantes.filter((userId) => userId !== member.id);
    },
    { diferido: true }
  );
  return { sorteo: actualizado ?? sorteo };
}

// Elige ganadores al azar (Fisher-Yates). `excluir` es para el reroll: primero intenta
// no repetir a los que ya ganaron y, si no alcanza la gente, elige igual entre todos
// antes que dejar el reroll vacío.
function elegirGanadores(participantes, cantidad, { excluir = [], alAzar = Math.random } = {}) {
  const todos = [...new Set(participantes.map(String))];
  const cantidadReal = Math.max(0, Math.min(Number(cantidad) || 0, todos.length));
  if (!cantidadReal) return [];

  const sinRepetir = todos.filter((id) => !excluir.includes(id));
  const bolsa = sinRepetir.length >= cantidadReal ? [...sinRepetir] : [...todos];

  for (let i = bolsa.length - 1; i > 0; i--) {
    const j = Math.floor(alAzar() * (i + 1));
    [bolsa[i], bolsa[j]] = [bolsa[j], bolsa[i]];
  }
  return bolsa.slice(0, cantidadReal);
}

// Cierra un sorteo y elige ganadores. Sin `forzar` solo cierra los vencidos (es lo que
// hace la pasada automática); con `forzar` el staff lo termina cuando quiera.
function finalizar(guildId, id, { forzar = false, ahora = Date.now(), alAzar } = {}) {
  const sorteo = obtener(guildId, id);
  if (!sorteo) return { error: 'Ese sorteo no existe.' };
  if (sorteo.estado === ESTADOS.finalizado) return { error: `El sorteo #${sorteo.id} ya está finalizado.` };
  if (sorteo.estado === ESTADOS.cancelado) return { error: `El sorteo #${sorteo.id} está cancelado.` };
  if (!forzar && ahora < sorteo.hasta) return { error: 'Ese sorteo todavía no terminó.' };

  const ganadores = elegirGanadores(sorteo.participantes, sorteo.ganadores, { alAzar });
  const actualizado = actualizar(guildId, id, (s) => {
    s.estado = ESTADOS.finalizado;
    s.ganadoresElegidos = ganadores;
    s.cerrado = ahora;
  });
  return { sorteo: actualizado, ganadores };
}

// Vuelve a sortear un sorteo terminado (sin repetir ganadores si hay gente suficiente).
function reroll(guildId, id, { alAzar } = {}) {
  const sorteo = obtener(guildId, id);
  if (!sorteo) return { error: 'Ese sorteo no existe.' };
  if (sorteo.estado !== ESTADOS.finalizado) return { error: 'Solo se puede volver a sortear un sorteo terminado.' };
  if (!sorteo.participantes.length) return { error: 'Ese sorteo no tuvo participantes: no hay a quién sortear.' };

  const ganadores = elegirGanadores(sorteo.participantes, sorteo.ganadores, {
    excluir: sorteo.ganadoresElegidos ?? [],
    alAzar,
  });
  const actualizado = actualizar(guildId, id, (s) => {
    s.ganadoresElegidos = ganadores;
    s.rerolls = (Number(s.rerolls) || 0) + 1;
  });
  return { sorteo: actualizado, ganadores };
}

// Cancela un sorteo abierto: el panel se queda en el canal, pero ya no invita a
// participar y no se sortea nada.
function cancelar(guildId, id, { ahora = Date.now() } = {}) {
  const sorteo = obtener(guildId, id);
  if (!sorteo) return { error: 'Ese sorteo no existe.' };
  if (sorteo.estado !== ESTADOS.abierto) return { error: `El sorteo #${sorteo.id} ya está ${sorteo.estado}.` };

  const actualizado = actualizar(guildId, id, (s) => {
    s.estado = ESTADOS.cancelado;
    s.cerrado = ahora;
  });
  return { sorteo: actualizado };
}

// ---------- Presentación ----------

function filaBotones(sorteo) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sorteo:entrar:${sorteo.id}`)
      .setLabel('Participar')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sorteo:salir:${sorteo.id}`).setLabel('Salir').setStyle(ButtonStyle.Secondary)
  );
}

// Embed + botones de un sorteo. Los botones solo existen mientras está abierto: un panel
// terminado no puede seguir sumando gente.
function vista(sorteo, { ahora = Date.now() } = {}) {
  const abierto = sorteo.estado === ESTADOS.abierto && ahora < sorteo.hasta;
  const ganadores = sorteo.ganadoresElegidos ?? [];
  const participantes = sorteo.participantes?.length ?? 0;

  const detalle =
    sorteo.estado === ESTADOS.cancelado
      ? '🚫 Este sorteo fue cancelado.'
      : sorteo.estado === ESTADOS.finalizado
        ? ganadores.length
          ? `🎉 **Ganador${ganadores.length === 1 ? '' : 'es'}:** ${ganadores.map((id) => `<@${id}>`).join(', ')}`
          : '😕 Nadie participó: el sorteo quedó desierto.'
        : `Termina ${marcaTiempo(sorteo.hasta, 'R')} · ${marcaTiempo(sorteo.hasta, 'f')}\nParticipá con el botón **🎉 Participar**.`;

  // El premio va una sola vez (en la cita); repetirlo en el título y en un campo era el
  // mismo dato tres veces en el mismo embed.
  const embed = brandEmbed({
    color: sorteo.estado === ESTADOS.cancelado ? COLORS.gris : ganadores.length ? COLORS.success : COLORS.info,
    title: `🎉 Sorteo #${sorteo.id}`,
    description: `> **${sorteo.premio}**\n\n${detalle}`,
    fields: [
      { name: 'Ganadores', value: `**${sorteo.ganadores}**`, inline: true },
      { name: 'Participantes', value: `**${miles(participantes)}**`, inline: true },
      {
        name: 'Requisito',
        value: sorteo.rolId ? `<@&${sorteo.rolId}>` : 'Ninguno: participa cualquiera',
        inline: true,
      },
    ],
    footer: `TriggerBOT • sorteo #${sorteo.id} • ${sorteo.estado}${sorteo.rerolls ? ` • ${sorteo.rerolls} reroll(s)` : ''}`,
  });

  return { embed, components: abierto ? [filaBotones(sorteo)] : [] };
}

// ---------- Integración con Discord ----------

async function canalDe(client, canalId) {
  if (!canalId) return null;
  const enCache = client?.channels?.cache?.get?.(canalId);
  if (enCache) return enCache;
  try {
    return (await client.channels.fetch(canalId)) ?? null;
  } catch {
    return null;
  }
}

// Vuelve a pintar el panel publicado. Si el mensaje se borró (o falta el permiso), lo
// registra y sigue: el sorteo ya está cerrado igual.
async function refrescarMensaje(client, sorteo) {
  if (!sorteo?.canalId || !sorteo?.mensajeId) return false;
  try {
    const canal = await canalDe(client, sorteo.canalId);
    if (!canal?.messages?.fetch) return false;
    const mensaje = await canal.messages.fetch(sorteo.mensajeId);
    const { embed, components } = vista(sorteo);
    await mensaje.edit({ embeds: [embed], components });
    return true;
  } catch (error) {
    log.warn(`No pude actualizar el panel del sorteo #${sorteo.id}`, error, { guild: sorteo.canalId });
    return false;
  }
}

// Anuncia el resultado en el canal del sorteo y avisa por DM a quien ganó.
async function anunciar(client, sorteo, { titulo = '🎉 Sorteo finalizado' } = {}) {
  const canal = await canalDe(client, sorteo.canalId);
  if (!canal?.send) return false;

  const ganadores = sorteo.ganadoresElegidos ?? [];
  const embed = brandEmbed({
    color: ganadores.length ? COLORS.success : COLORS.gris,
    title: titulo,
    description: ganadores.length
      ? `**${sorteo.premio}**\n\n${ganadores.map((id) => `<@${id}>`).join(', ')}`
      : `**${sorteo.premio}**\n\nEl sorteo quedó desierto: nadie se anotó.`,
    footer: `TriggerBOT • sorteo #${sorteo.id} • ${miles(sorteo.participantes?.length ?? 0)} participantes`,
  });

  await canal
    .send({
      embeds: [embed],
      content: ganadores.length ? '¡Tenemos resultado!' : undefined,
      allowedMentions: { users: ganadores },
    })
    .catch((error) => log.warn(`No pude anunciar el sorteo #${sorteo.id}`, error));

  for (const userId of ganadores) {
    try {
      const usuario = await client?.users?.fetch?.(userId);
      await usuario?.send?.({
        embeds: [
          brandEmbed({
            color: COLORS.success,
            title: '¡Ganaste un sorteo!',
            description: `Ganaste **${sorteo.premio}** en el sorteo #${sorteo.id} de **${sorteo.guildNombre ?? 'Trigger.Arena'}**.\n\nHablá con el staff para reclamar tu premio.`,
          }),
        ],
      });
    } catch {
      /* DM cerrado: el anuncio público ya avisa */
    }
  }
  return true;
}

// Botón del panel (Participar / Salir). Siempre contesta en efímero: la entrada no
// llena el canal y nadie ve el error de otro.
async function manejarBoton(interaction) {
  const [, accion, id] = String(interaction.customId ?? '').split(':');
  const guildId = interaction.guildId ?? interaction.guild?.id;
  const responder = (contenido) => interaction.reply({ content: contenido, flags: MessageFlags.Ephemeral });

  if (!guildId) return responder('Los sorteos solo funcionan dentro de un servidor.');

  if (accion === 'entrar') {
    const resultado = entrar(guildId, id, interaction.member);
    if (resultado.error) return responder(`⚠️ ${resultado.error}`);
    if (resultado.yaEstaba) return responder(`Ya estás participando del sorteo #${id}. 🎉`);
    return responder(`🎉 ¡Estás participando del sorteo #${id}! Suerte.`);
  }

  if (accion === 'salir') {
    const resultado = salir(guildId, id, interaction.member);
    if (resultado.error) return responder(`⚠️ ${resultado.error}`);
    if (resultado.noEstaba) return responder(`No estabas participando del sorteo #${id}.`);
    return responder(`Saliste del sorteo #${id}. Podés volver a entrar mientras siga abierto.`);
  }

  return responder('No entendí esa acción del sorteo.');
}

// Pasada automática: cierra los sorteos vencidos, actualiza el panel y anuncia.
// Un error en un servidor no frena a los demás.
async function procesar(client, { ahora = Date.now(), alAzar } = {}) {
  const resumen = { revisados: 0, finalizados: 0, errores: 0 };

  for (const guild of client?.guilds?.cache?.values?.() ?? []) {
    for (const sorteo of abiertos(guild.id)) {
      if (ahora < sorteo.hasta) continue;
      resumen.revisados += 1;
      try {
        const resultado = finalizar(guild.id, sorteo.id, { ahora, alAzar });
        if (!resultado.sorteo) {
          resumen.errores += 1;
          continue;
        }
        resumen.finalizados += 1;
        await refrescarMensaje(client, { ...resultado.sorteo, guildNombre: guild.name });
        await anunciar(client, { ...resultado.sorteo, guildNombre: guild.name });
      } catch (error) {
        resumen.errores += 1;
        log.error(`Error al cerrar el sorteo #${sorteo.id}`, error, { guild: guild.id });
      }
    }
  }

  return resumen;
}

module.exports = {
  // Reglas y estado.
  parsearDuracion,
  lista,
  abiertos,
  obtener,
  crear,
  adjuntarMensaje,
  motivoNoParticipa,
  entrar,
  salir,
  elegirGanadores,
  finalizar,
  reroll,
  cancelar,
  // Presentación e integración.
  vista,
  filaBotones,
  refrescarMensaje,
  anunciar,
  manejarBoton,
  procesar,
  // Constantes (tests y documentación).
  DURACION_MINIMA_MS,
  DURACION_MAXIMA_MS,
  MAX_GANADORES,
  MAX_ABIERTOS,
  MAX_PARTICIPANTES,
  ESTADOS,
};
