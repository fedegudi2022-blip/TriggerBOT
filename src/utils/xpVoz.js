// XP por voz: suma XP por el tiempo que alguien pasa en un canal de voz, con las reglas
// que evitan el farmeo (solo / muteado / sordo / canal AFK / canales excluidos / tope
// diario). El estado es en memoria a propósito: si el bot se reinicia, el minuto en curso
// se pierde y el conteo arranca de nuevo; la XP en sí la persiste niveles.js con su
// sincronización.
//
// El pago va por BARRIDO (index.js lo corre cada minuto) y no por evento: el minuto se
// cuenta solo si al momento de pagar la persona sigue en el canal y las condiciones se
// siguen cumpliendo. Así, mutearse o quedarse solo a mitad de camino no paga.

const { otorgarXP, diaArg } = require('../niveles');
const { asignarRolesNivel } = require('./rolesNivel');
const { anunciarProgreso } = require('./anunciosNivel');
const { vozDe } = require('./voz');

const POR_MINUTO = 8;
const MAXIMO_DIARIO = 200; // por usuario y por día (hora argentina)
const PERIODO_MS = 60_000;
const MINIMO_PERSONAS = 2; // estar solo no cuenta: es la forma más fácil de farmear

const presencias = new Map(); // 'guildId:userId' → { guildId, userId, canalId, ultimoPago }
let dia = null;
const ganadoHoy = new Map(); // userId → XP de voz de hoy (en memoria)

function clave(guildId, userId) {
  return `${guildId}:${userId}`;
}

// Motivo por el que el minuto no paga XP (null = paga). Se evalúa en cada barrido.
function motivoParaNoPagar(member, canal, guild) {
  if (!member?.voice || !canal) return 'sin datos';
  if (member.user?.bot) return 'es un bot';
  if (member.voice.selfMute || member.voice.selfDeaf) return 'está muteado o sordo';
  if (member.voice.channelId !== canal.id) return 'ya no está en ese canal';

  // Interruptor del staff: `voz.xpActivada = false` apaga la XP por voz en todo el
  // servidor sin tocar el código (es la salida rápida si la economía se desmadra).
  const voz = vozDe(guild.id);
  if (voz.xpActivada === false) return 'XP por voz desactivada';
  if (guild.afkChannelId && canal.id === guild.afkChannelId) return 'es el canal AFK';
  if ((voz.canalesSinXP ?? []).includes(canal.id)) return 'canal excluido';
  const personas = canal.members?.filter((m) => !m.user?.bot).size ?? 0;
  if (personas < MINIMO_PERSONAS) return 'está solo en el canal';
  if ((ganadoHoy.get(member.id) ?? 0) >= MAXIMO_DIARIO) return 'llegó al tope diario';
  return null;
}

// Lo llama voiceStateUpdate en cada cambio de voz. `ahora` se puede pasar para los tests.
function registrar(estado, ahora = Date.now()) {
  if (!estado?.guild?.id || !estado.id) return false;
  const k = clave(estado.guild.id, estado.id);

  if (!estado.channelId) {
    presencias.delete(k);
    return false;
  }

  const previa = presencias.get(k);
  const muteado = Boolean(estado.selfMute || estado.selfDeaf);
  // El minuto arranca de cero al ENTRAR, al CAMBIAR de canal y al MUTEARSE o desmutearse.
  // Sin lo del mute, alguien que se mutea justo después de un pago y se desmutea justo
  // antes del siguiente cobraba igual: el barrido lo veía desmuteado y pagaba el minuto
  // entero. Y sin lo del cambio de canal, entrar y salir juntaría minutos "en el aire".
  if (!previa || previa.canalId !== estado.channelId || previa.muteado !== muteado) {
    presencias.set(k, { guildId: estado.guild.id, userId: estado.id, canalId: estado.channelId, ultimoPago: ahora, muteado });
  }
  return true;
}

// Registra a quien ya estaba conectado cuando el bot arranca: si no, tendría que cambiar
// de estado para empezar a contar.
function sembrar(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const estado of guild.voiceStates?.cache?.values?.() ?? []) {
      if (estado.channelId) registrar({ guild, id: estado.id, channelId: estado.channelId });
    }
  }
}

// Una pasada: paga el minuto completo a quien corresponde en este momento.
async function pasada(client, ahora = Date.now()) {
  reiniciarDia();

  for (const [k, p] of [...presencias]) {
    const guild = client.guilds.cache.get(p.guildId);
    const member = guild?.members.cache.get(p.userId);
    const canal = guild?.channels.cache.get(p.canalId);

    if (!member || !canal) {
      presencias.delete(k);
      continue;
    }

    if (motivoParaNoPagar(member, canal, guild)) {
      // No acumula tiempo mientras las condiciones no se cumplen: al volver, el minuto
      // arranca de cero.
      p.ultimoPago = ahora;
      continue;
    }

    if (ahora - p.ultimoPago < PERIODO_MS) continue;

    p.ultimoPago = ahora;
    await pagar(client, p);
  }
}

// Otorga el minuto y, si eso hizo subir de nivel, anuncia igual que por mensajes.
async function pagar(client, p) {
  const cantidad = Math.min(POR_MINUTO, MAXIMO_DIARIO - (ganadoHoy.get(p.userId) ?? 0));
  if (cantidad <= 0) return 0;

  ganadoHoy.set(p.userId, (ganadoHoy.get(p.userId) ?? 0) + cantidad);

  const progreso = otorgarXP(p.guildId, p.userId, cantidad);
  if (!progreso.subio) return cantidad;

  const guild = client.guilds.cache.get(p.guildId);
  const member = guild?.members.cache.get(p.userId);
  if (!member) return cantidad;

  const roles = await asignarRolesNivel(member, progreso.nivelNuevo);
  // El anuncio no necesita un mensaje: le alcanza con el guild y el autor.
  await anunciarProgreso({ guild, author: member.user }, progreso, roles);
  return cantidad;
}

function reiniciarDia() {
  const hoy = diaArg(new Date());
  if (dia === hoy) return;
  dia = hoy;
  ganadoHoy.clear();
}

// Solo para los tests.
function resetear() {
  presencias.clear();
  ganadoHoy.clear();
  dia = null;
}

module.exports = {
  registrar,
  sembrar,
  pasada,
  motivoParaNoPagar,
  reiniciarDia,
  resetear,
  presencias,
  ganadoHoy,
  POR_MINUTO,
  MAXIMO_DIARIO,
  PERIODO_MS,
};
