// Escalada automática de advertencias.
//
// Antes el "3 warns → 1 hora de timeout" estaba escrito a mano dentro de /warn.
// Acá vive toda la política: el servidor elige cuándo dispara, qué acción se aplica
// y cuánto dura, y /warn solo pregunta "¿corresponde?" y ejecuta.
//
// La config vive en config.escalada = { activada, umbral, duracion, accion }.

const { textoDuracion } = require('./replies');

// Acciones posibles, de la más suave a la más dura. El orden importa: el panel las
// muestra en este orden y el valor `ninguna` es el único que no sanciona.
const ACCIONES = {
  ninguna: 'Solo acumular (no sanciona)',
  timeout: 'Silencio temporal (timeout)',
  mute: 'Rol de silenciado',
  kick: 'Expulsar',
  ban: 'Banear',
};

// Por defecto se mantiene el comportamiento histórico: al 3.º aviso, 1 hora.
const POR_DEFECTO = { activada: true, umbral: 3, duracion: 60, accion: 'timeout' };

// Límites sanos: un umbral de 1 haría que el primer aviso expulse a alguien y
// duraciones por encima de 28 días no las acepta Discord en un timeout.
const LIMITES = { umbral: [1, 20], duracion: [1, 40_320] };

// Solo estas acciones no dependen de tener un miembro del servidor a mano.
const SIN_MIEMBRO = new Set(['timeout', 'mute', 'kick', 'ban']);

function acotar(valor, [min, max], porDefecto) {
  const n = Math.round(Number(valor));
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(Math.max(n, min), max);
}

// Normaliza la config guardada: cualquier valor viejo, raro o incompleto sale de acá
// ya válido, así el resto del código no tiene que defenderse.
function resolver(config = {}) {
  const crudo = { ...POR_DEFECTO, ...(config.escalada || {}) };
  return {
    activada: crudo.activada !== false,
    umbral: acotar(crudo.umbral, LIMITES.umbral, POR_DEFECTO.umbral),
    duracion: acotar(crudo.duracion, LIMITES.duracion, POR_DEFECTO.duracion),
    accion: ACCIONES[crudo.accion] ? crudo.accion : POR_DEFECTO.accion,
  };
}

function duracionMs(escalada) {
  return escalada.duracion * 60_000;
}

// ¿Este total de advertencias dispara la escalada?
function corresponde(escalada, total) {
  return escalada.activada && escalada.accion !== 'ninguna' && total >= escalada.umbral;
}

// Texto de una línea para el panel, el log y la confirmación.
// "Al llegar a 3 advertencias: Silencio temporal (timeout) de 1 hora".
function describir(escalada) {
  if (!escalada.activada) return 'Escalada apagada: los avisos solo se acumulan.';
  if (escalada.accion === 'ninguna') return `Al llegar a ${escalada.umbral} advertencia(s) no se sanciona: solo se acumula el historial.`;
  const detalle = escalada.accion === 'mute' ? 'con el rol Silenciado (no vence solo, se quita con /unmute)' : `de ${textoDuracion(duracionMs(escalada))}`;
  return `Al llegar a **${escalada.umbral}** advertencia(s): **${ACCIONES[escalada.accion]}** ${detalle}.`;
}

// Aplica la acción configurada. Devuelve { ok, error, tipo } y NUNCA lanza: los
// errores de permisos/jerarquía se devuelven para que /warn los reporte tal cual.
async function aplicar(member, escalada, motivo) {
  const { intentar } = require('./acciones');
  const ms = duracionMs(escalada);

  if (escalada.accion === 'timeout') {
    if (!member.moderatable) return { ok: false, tipo: 'timeout', error: 'Su rol está por encima del mío (o es el dueño del servidor).' };
    return { ...(await intentar('Discord rechazó el silencio automático', () => member.timeout(ms, motivo))), tipo: 'timeout' };
  }

  if (escalada.accion === 'mute') {
    if (!member.manageable) return { ok: false, tipo: 'mute', error: 'Su rol está por encima del mío (o es el dueño del servidor).' };
    let rol;
    try {
      // Require diferido: la fábrica del rol vive con /mute y así no hay ciclo de
      // imports entre utilidades.
      rol = await require('../commands/mute').asegurarRolMute(member.guild);
    } catch (e) {
      return { ok: false, tipo: 'mute', error: `No pude crear el rol Silenciado: ${e.message}` };
    }
    return { ...(await intentar('Discord rechazó el rol de silenciado', () => member.roles.add(rol, motivo))), tipo: 'mute' };
  }

  if (escalada.accion === 'kick') {
    if (!member.kickable) return { ok: false, tipo: 'kick', error: 'No puedo expulsarlo: su rol está por encima del mío.' };
    return { ...(await intentar('Discord rechazó la expulsión automática', () => member.kick(motivo))), tipo: 'kick' };
  }

  if (escalada.accion === 'ban') {
    if (!member.bannable) return { ok: false, tipo: 'ban', error: 'No puedo banearlo: su rol está por encima del mío.' };
    return { ...(await intentar('Discord rechazó el ban automático', () => member.ban({ reason: motivo }))), tipo: 'ban' };
  }

  return { ok: false, tipo: 'ninguna', error: 'La escalada está configurada para no sancionar.' };
}

module.exports = { ACCIONES, POR_DEFECTO, LIMITES, SIN_MIEMBRO, resolver, duracionMs, corresponde, describir, aplicar };
