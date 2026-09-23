// Plomería compartida por los comandos de moderación.
//
// Nace de tres bugs que se repetían en casi todos los comandos:
//
//  1. La respuesta se armaba DESPUÉS de la acción (fetch + DM + API de Discord).
//     Si eso pasaba de 3 segundos, Discord cortaba la interacción: la sanción se
//     aplicaba pero el staff solo veía "la aplicación no respondió".
//  2. Las acciones se lanzaban sin try/catch, así que un rechazo de Discord salía
//     como el error genérico de index.js ("❌ Ocurrió un error…") y, como el
//     logAction venía después, el caso NUNCA quedaba registrado en el mod-log.
//  3. El aviso por DM se mandaba antes de la acción: si Discord rechazaba la
//     sanción, el usuario igual recibía el mensaje de que había sido sancionado.
//
// Con estos helpers: se difiere ANTES de tocar la API, cada operación devuelve su
// resultado real ({ ok, error }) y el DM sale recién cuando la acción se aplicó.

const { MessageFlags } = require('discord.js');

// Discord no deja borrar en bloque mensajes de más de 14 días (y exige entre 2 y 100
// mensajes por llamada). Vive acá porque lo necesitan los dos caminos que borran
// mensajes: el comando /clear y las órdenes por chat con IA (utils/accionesIA.js).
const LIMITE_14_DIAS_MS = 14 * 86400_000;

// ¿El staff pidió que la confirmación la vea solo él? (opción `silencioso`).
function quiereSilencioso(interaction) {
  return interaction.options?.getBoolean?.('silencioso') === true;
}

// Diferimos la respuesta antes de cualquier llamada a Discord. Es idempotente:
// si la interacción ya fue diferida (por ejemplo al resolver un miembro que no
// estaba en caché), no hace nada.
async function diferir(interaction, silencioso = false) {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply(silencioso ? { flags: MessageFlags.Ephemeral } : {});
}

// Resuelve el miembro objetivo sin comerse la ventana de 3 segundos: casi siempre
// ya está en la caché del servidor (el bot tiene el intent de miembros), así que es
// instantáneo. Solo si falta se difiere (efímero, para no ensuciar el canal) antes
// de pedirlo a la API.
async function resolverMiembro(interaction, opcion = 'usuario') {
  const enCache = interaction.options.getMember(opcion);
  if (enCache) return enCache;

  await diferir(interaction, true);
  const user = interaction.options.getUser(opcion, true) ?? interaction.options.getUser(opcion);
  if (!user) return null;
  return interaction.guild.members.fetch(user.id).catch(() => null);
}

// Ejecuta una operación de Discord y devuelve el resultado REAL: { ok } o
// { ok: false, error } con un motivo legible para mostrarle al staff.
async function intentar(descripcion, fn) {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${descripcion}: ${error.message}` };
  }
}

// Responde tanto si la interacción fue diferida como si no. Los comandos no tienen
// que saber en qué estado quedó la interacción después de validar.
async function responder(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

module.exports = { quiereSilencioso, diferir, resolverMiembro, intentar, responder, LIMITE_14_DIAS_MS };
