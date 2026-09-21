const { brandEmbed } = require('./replies');

// Guía completa del bot, con el estilo visual unificado.
// La usan tanto el comando /help como la respuesta al mencionar al bot.
function construirGuia(client) {
  return brandEmbed({
    color: 0x5865f2,
    title: `👋 Hola! Soy ${client.user.username}`,
    description: 'Soy el bot de moderación de la comunidad Trigger. Acá va una guía rápida de todo lo que sé hacer.',
    fields: [
      {
        name: '🛡️ Moderación',
        value:
          '`/warn` · `/warnings` · `/quitarnota` · `/kick` · `/ban` · `/unban`\n' +
          '`/softban` · `/timeout` · `/mute` · `/unmute` · `/clear` · `/lockdown` · `/slowmode`',
      },
      {
        name: '⚠️ Warns',
        value:
          'Al **3er `/warn`** el usuario queda silenciado 1 hora automáticamente. ' +
          'Consultá el historial con `/warnings` y borrá advertencias con `/quitarnota`.',
      },
      {
        name: '⚙️ Configuración (staff)',
        value: '`/config ver` · `welcome` · `modlog` · `logs` · `avisos` · `staff` · `mute` · `desactivar`',
      },
      {
        name: '💡 Datos útiles',
        value:
          '• Todos los comandos de moderación avisan al usuario por DM y quedan registrados en el mod-log.\n' +
          '• Necesitás permisos de moderación o un rol de staff (configurable con `/config staff`).\n' +
          '• Si me mencionás en el chat, te puedo contestar: salúdame o pedime `ping`.',
      },
    ],
    footer: 'TriggerBOT • usá /help cuando necesites la guía',
  });
}

module.exports = { construirGuia };
