const { Events } = require('discord.js');
const censo = require('../utils/censo');

// El conteo de «en línea» de los canales de estadísticas se mantiene con los cambios de
// presencia, no con un fetch por pasada: en un servidor grande descargar la lista de
// miembros cada 10 minutos sería inviable. Sin censo previo este evento no cuenta nada
// (utils/censo.js lo explica): arrancar a sumar sobre la nada daría un total inventado.
module.exports = {
  name: Events.PresenceUpdate,
  execute(vieja, nueva) {
    censo.actualizarPresencia(vieja, nueva);
  },
};
