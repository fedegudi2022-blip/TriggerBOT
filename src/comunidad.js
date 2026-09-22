// Identidad y links de TriGGer.Arena — FUENTE ÚNICA de estos datos.
// Si cambia un link o el dueño, se edita solo acá y todo el bot lo refleja
// (comandos /redes y /web, respuestas instantáneas de charla y el prompt de la IA).

// Dueño y creador del bot (Federico). La IA lo menciona cuando preguntan quién lo creó.
const DUENO_ID = '1055093032887791726';
const DUENO_MENCION = `<@${DUENO_ID}>`;

// Página web oficial.
const WEB = 'https://triggerarena.pro/';

// Redes sociales oficiales (el orden es el que se muestra en /redes).
const REDES = [
  { nombre: 'WhatsApp', emoji: '💬', url: 'https://chat.whatsapp.com/EzTxg9dGbM1EG8alInMbEM', desc: 'Grupo oficial de WhatsApp' },
  { nombre: 'Steam', emoji: '🎮', url: 'https://steamcommunity.com/chat/invite/QvvTJ95E', desc: 'Grupo oficial de Steam' },
  { nombre: 'Instagram', emoji: '📸', url: 'https://www.instagram.com/trigger.arena_cs', desc: '@trigger.arena_cs' },
];

module.exports = { DUENO_ID, DUENO_MENCION, WEB, REDES };
