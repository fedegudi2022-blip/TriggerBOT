// Anuncio de progreso de niveles: un solo mensaje de texto por evento.
// Lo usan el canal de mensajes (events/messageCreate.js) y la XP por voz
// (utils/xpVoz.js), por eso vive acá y no dentro del evento.
//
// Antes: un embed por logro más el de la subida (una subida con 3 logros nuevos eran 4
// mensajes). Ahora todo lo que pasó se cuenta UNA vez y en UN mensaje, en líneas cortas:
// qué pasó y con cuánta XP, dónde quedó parado, logros, rol ganado y cambio de rango. Las
// líneas que no aplican no se agregan, así el mensaje queda corto cuando pasó una sola cosa.

const { datosDe, xpParaNivel, canalAnuncios, rangoDe, XP_PROMEDIO, LOGROS } = require('../niveles');
const { miles } = require('./replies');

// Arma el texto del anuncio. `message` puede ser un mensaje real o un contexto con la
// misma forma ({ guild, author }), que es lo que hace la XP por voz.
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

module.exports = { textoProgreso, anunciarProgreso };
