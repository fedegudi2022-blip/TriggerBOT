// Charla simple cuando alguien menciona al bot: saludos, cortesías, piropos,
// insultos, preguntas de moderación y frases de la comunidad Trigger.
// La guía completa de comandos vive exclusivamente en /help — acá solo hay conversación.

function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // quita tildes: "cómo" → "como"
}

function elegir(lista) {
  return lista[Math.floor(Math.random() * lista.length)];
}

const RESPUESTAS = {
  vacio: [
    '¡Hola! 👋 ¿Necesitás algo? Si querés ver mis comandos, usá /help',
    'Acá estoy 👀 ¿Qué se te ofrece? (usá /help para ver la guía)',
    '¿Me mencionaste? 😄 Estoy para servir, cualquier duda usá /help',
  ],
  saludo: [
    '¡Hola! ¿Cómo andas? 👋',
    '¡Hola! ¿Todo bien por acá? 😄',
    '¡Ey! Bienvenido, ¿qué se cuenta?',
    '¡Hola! Acá ando, atento a todo 👀',
  ],
  comoestas: [
    '¡Todo bien, moderando un poco el server! ¿Y vos? 😄',
    'De 10, gracias por preguntar. ¿Vos cómo estás?',
    '¡Full energía! ⚡ ¿Necesitás ayuda con algo?',
    'Bien, vigilando que nadie haga desastres 😎 ¿Y vos?',
  ],
  gracias: [
    '¡De nada! Para eso estoy 😎',
    '¡No hay de qué!',
    '¡Un gusto ayudar! 🙌',
    '¡Siempre! Cualquier cosa avisame 👌',
  ],
  despedida: [
    '¡Chau! Acá voy a estar si me necesitás 👋',
    '¡Nos vemos! Que andes bien 🙌',
    '¡Hasta luego! No rompas nada 😄',
  ],
  piropo: [
    'Ay, me sonrojo... 🤖❤️ ¡Gracias!',
    'Lo sé, soy adorable ✨ Pero shh, no quiero celos del resto de los bots',
    '¡Crack vos! 🙌',
    'Gracias, hago lo que puedo entre moderar y responder 😎',
  ],
  insulto: [
    'Tranquilo 😅 Acá todos respetamos; las reglas están para algo.',
    'Los insultos me rebotan 🛡️ Mejor charlamos de otra cosa.',
    'Mmm... te recomiendo bajar un cambio, el staff ve todo 👀',
    'Sigo siendo tu bot favorito, negarlo no te va a hacer feliz 😌',
  ],
  risa: [
    'JAJAJA 😂',
    'Jaja, me alegra hacerte reír 😄',
    'xDDD buenísimo',
  ],
  comunidad: [
    '¡Trigger presente! 💪 El mejor server, sin discusión.',
    '¡GG! 🔥 Buenísima esa.',
    'Trigger.Arena no duerme 🏆 Acá moderando siempre.',
    'Este server es una familia (ruidosa, pero familia) 😄',
  ],
  moderacion: [
    'Es mi especialidad 🛡️ Todo mi arsenal está en /help: warn, ban, kick, timeout, mute, lockdown y más.',
    'Moderar es mi pasión 🛡️ Mirá /help para ver todo lo que puedo hacer.',
  ],
  ayuda: [
    'Si querés ver la guía completa de comandos, usá /help ✨',
    'Todo lo que sé hacer está en /help, dale un vistazo 😄',
  ],
  fallo: [
    'Mmm, no entendí eso 😅 Si querés ver todo lo que sé hacer, usá /help',
    'Eso no lo capto... probá con /help, ahí está la guía completa',
    'Todavía no aprendí a responder eso 😅 pero en /help tenés mis comandos',
  ],
};

// Emojis que el bot usa cuando decide reaccionar en vez de contestar.
const EMOJIS_REACCION = ['👍', '😄', '🔥', '👀', '💪', '⭐', '🤖', '❤️', '😎', '🫡'];

// Respuestas puntuales a preguntas de moderación. Devuelve el texto o null.
function responderPreguntaModeracion(texto) {
  if (/\b(banear|banea|baneo|banneo|expulsar|expulsa|expulso|kickear|kickeo|ban|kick)\b/.test(texto)) {
    return 'Fácil: `/ban usuario [razón]` o `/kick usuario [razón]`. Necesitás permisos de mod o un rol de staff 🛡️';
  }
  if (/\b(silenciar|silencia|silencio|muteo|mutear|mute|timeout|timear)\b/.test(texto)) {
    return 'Usá `/timeout usuario duración` (temporal) o `/mute usuario` (con rol, hasta que lo quiten) 🔇';
  }
  if (/\b(warns?|advertencias?|quitarnota)\b/.test(texto)) {
    return 'Al **3er `/warn`** el usuario queda silenciado 1 hora automático. Con `/warnings` ves el historial y con `/quitarnota` borrás una ⚠️';
  }
  if (/\b(desbanear|desbaneo|desbanes|unban)\b/.test(texto)) {
    return 'Con `/unban usuario_id` revocás un baneo (la ID se copia con clic derecho sobre el usuario) 🔓';
  }
  if (/\b(lockdown|lock|bloque(a|o|ar|ando)|desbloque(a|o|ar|ando))\b/.test(texto) && /\bcanal\b/.test(texto)) {
    return 'Para cerrar o reabrir un canal usá `/lockdown` con la acción `bloquear` o `desbloquear` 🔒';
  }
  if (
    /\b(borr(a|o|ar|ando)|limpi(a|o|ar|ando)|purg(a|o|ar|ando))\b/.test(texto) &&
    /\b(mensajes?|chat|canal)\b/.test(texto)
  ) {
    return 'Con `/clear cantidad` borro hasta 100 mensajes recientes de un canal 🧹';
  }
  if (/\b(staff|admins?|moderadores?|helper)\b/.test(texto) && /\b(como|quien|que|configurar|definir)\b/.test(texto)) {
    return 'El staff se define con `/config staff` (roles admin, mod y helper) 👑';
  }
  if (/\bdueno\b/.test(texto)) {
    return 'El dueño se reconoce por la corona 👑 y el staff se configura con `/config staff`.';
  }
  return null;
}

// Devuelve una respuesta de charla para el texto dado (ya normalizado).
function responderCharla(texto) {
  if (!texto) return elegir(RESPUESTAS.vacio);

  if (/\b(gracias|thanks|thank you)\b/.test(texto)) return elegir(RESPUESTAS.gracias);  if (/\b(tonto|tonta|feo|fea|inutil|inservible|basura|estupid[oa]|tarad[oa]|bob[oa]|payas[oa]|idiota|imbecil|malparid[oa]|forro|forra|mierda|pelotud[oa]|bolud[oa]|pendej[oa]|gil)\b/.test(
      texto
    )
  ) {
    return elegir(RESPUESTAS.insulto);
  }
  if (/\b(te amo|te quiero|te adoro|lind[oa]|hermos[oa]|guap[oa]|crack|idolo|el mejor|la mejor|me gustas|capo|capa)\b/.test(texto)) {
    return elegir(RESPUESTAS.piropo);
  }
  if (/\b(chau|adios|nos vemos|hasta luego|me voy|bye)\b/.test(texto)) return elegir(RESPUESTAS.despedida);
  if (/\bcomo (estas|andas|te va|va todo)|^que tal\b|todo bien\?$/.test(texto)) return elegir(RESPUESTAS.comoestas);
  if (/(^|\s)(jaja+|jeje+|jiji+|jsjs+|xd+|lol|lmao)/.test(texto)) return elegir(RESPUESTAS.risa);
  if (/\b(trigger|arena|gg|ggs|ez|easy|1v1|clutch|ace|clan)\b/.test(texto)) return elegir(RESPUESTAS.comunidad);

  const preguntaModeracion = responderPreguntaModeracion(texto);
  if (preguntaModeracion) return preguntaModeracion;
  if (/\b(moderacion|moderando|moderas|mod)\b/.test(texto)) return elegir(RESPUESTAS.moderacion);

  if (/\b(hola|holis|holaa+|buenas|hey|hello|aloja|buen dia|buenos dias|buenas tardes|buenas noches)\b/.test(texto)) {
    return elegir(RESPUESTAS.saludo);
  }
  if (/\b(ayuda|help|guia|comandos?|como te uso)\b/.test(texto)) return elegir(RESPUESTAS.ayuda);

  return elegir(RESPUESTAS.fallo);
}

module.exports = { responderCharla, normalizar, EMOJIS_REACCION };
