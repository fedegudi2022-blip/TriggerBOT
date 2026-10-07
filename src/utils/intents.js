// Intents del gateway que pide el bot.
//
// Vive aparte de index.js por un motivo concreto: el Presence Intent es **privilegiado**, y
// si el bot lo pide sin tenerlo habilitado en el portal, Discord cierra la conexión
// (error «Used disallowed intents») y el bot no arranca. La variable PRESENCE_INTENT es la
// salida de emergencia, y acá se puede probar sin levantar el cliente entero.

const { GatewayIntentBits } = require('discord.js');

// Intents fijos: sin ellos el bot no ve mensajes, miembros ni entradas a los canales de voz.
const BASE = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildVoiceStates, // necesario para detectar quién entra a «Crear canal»
];

// `entorno` es inyectable para los tests; en producción es process.env.
// Solo el valor exacto 'false' lo apaga: una variable ausente o vacía mantiene el intent
// (es lo que necesitan los canales de estadísticas para contar «en línea»).
function intentsDe(entorno = process.env) {
  const lista = [...BASE];
  if (entorno?.PRESENCE_INTENT !== 'false') lista.push(GatewayIntentBits.GuildPresences);
  return lista;
}

module.exports = { intentsDe, BASE };
