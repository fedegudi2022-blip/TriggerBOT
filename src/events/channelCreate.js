// Canal nuevo con el rol Silenciado ya creado: hay que negarle los permisos ahí.
//
// Por qué existe: `asegurarRolMute()` (commands/mute.js) aplica el deny a los canales
// que existen EN ESE MOMENTO. Todo canal creado después (una categoría nueva, un canal
// de voz temporal, un canal de evento) quedaba sin la restricción y el usuario
// silenciado podía escribir o hablar ahí. Este evento cierra ese agujero.
const { Events, ChannelType } = require('discord.js');
const { getGuildConfig } = require('../store');

const TIPOS_APLICABLES = [
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
];

module.exports = {
  name: Events.ChannelCreate,
  async execute(channel) {
    // El deny se aplica igual a las categorías: sus hijos heredan el permiso salvo
    // que tengan su propio overwrite.
    const aplicable = TIPOS_APLICABLES.includes(channel.type) || channel.type === ChannelType.GuildCategory;
    if (!aplicable || !channel.manageable) return;

    const muteRole = getGuildConfig(channel.guild?.id).muteRole;
    if (!muteRole) return; // el servidor no usa el sistema de silencio con rol

    // Require tardío: mute.js carga discord.js y el store, y evita un ciclo de requires
    // al arrancar (events se cargan desde index.js antes que los comandos).
    const { DENEGADOS_MUTE } = require('../commands/mute');

    try {
      await channel.permissionOverwrites.edit(muteRole, DENEGADOS_MUTE, {
        reason: 'TriggerBOT: mantener el silencio en canales nuevos',
      });
    } catch (error) {
      console.warn(`[TriggerBOT] No pude aplicar el silencio al canal nuevo #${channel.name}: ${error.message}`);
    }
  },
};
