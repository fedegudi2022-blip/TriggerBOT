const { Events } = require('discord.js');
const { manejarCambio } = require('../utils/voz');

module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    try {
      await manejarCambio(oldState, newState);
    } catch (error) {
      console.error('[TriggerBOT] Error en canales de voz temporales:', error.message);
    }
  },
};
