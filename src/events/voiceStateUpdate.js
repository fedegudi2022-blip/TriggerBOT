const { Events } = require('discord.js');
const { manejarCambio } = require('../utils/voz');
const xpVoz = require('../utils/xpVoz');

module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    try {
      await manejarCambio(oldState, newState);
    } catch (error) {
      console.error('[TriggerBOT] Error en canales de voz temporales:', error.message);
    }

    // XP por voz: acá solo se anota quién está en qué canal; el pago lo hace el barrido
    // de cada minuto (utils/xpVoz.js), que reevalúa las condiciones antes de pagar.
    try {
      xpVoz.registrar(newState);
    } catch (error) {
      console.error('[TriggerBOT] Error anotando la presencia de voz:', error.message);
    }
  },
};
