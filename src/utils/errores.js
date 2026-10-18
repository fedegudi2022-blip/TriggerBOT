// Respuesta uniforme a un error inesperado de una interacción.
//
// Antes cada handler de index.js repetía el mismo `try/catch` y contestaba
// "Ocurrió un error…" sin nada que permitiera rastrearlo en los logs. Ahora cada error
// lleva un código corto (TB-XXXXX) que se registra junto al stack y se le muestra a la
// persona: cuando alguien reporta el problema, el staff busca ese código y encuentra la
// línea exacta en vez de adivinar por la hora.
const { MessageFlags } = require('discord.js');
const crearLogger = require('../logger');

const log = crearLogger('errores');

let secuencia = 0;

// Código legible y único dentro del proceso: 3 caracteres de tiempo + 2 de secuencia.
// Se reinicia con el proceso; el log guarda el stack completo al lado del código.
function codigoDeError(ahora = Date.now()) {
  secuencia = (secuencia + 1) % 1296; // 36² combinaciones antes de dar la vuelta
  const tiempo = ahora.toString(36).slice(-3).toUpperCase();
  const orden = secuencia.toString(36).toUpperCase().padStart(2, '0');
  return `TB-${tiempo}${orden}`;
}

// Registra el error y contesta en efímero (o por followUp si ya se había contestado).
// Devuelve el código para que el llamador pueda usarlo en un test o en otro log.
async function responderError(interaction, error, { que = 'ejecutar el comando', contexto = {} } = {}) {
  const codigo = codigoDeError();
  log.error(`Error al ${que}`, error, { ...contexto, codigo });

  const payload = {
    content: `Ocurrió un error al ${que}. Si se repite, pasale este código al staff: \`${codigo}\`.`,
    flags: MessageFlags.Ephemeral,
  };

  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    /* la interacción ya expiró o el canal se borró: el log ya tiene el código */
  }

  return codigo;
}

module.exports = { responderError, codigoDeError };
