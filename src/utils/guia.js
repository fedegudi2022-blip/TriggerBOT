const { brandEmbed } = require('./replies');

// Guía completa del bot organizada por categorías, con el estilo visual unificado.
// La usan tanto el comando /help como la respuesta al mencionar al bot.
function construirGuia(client) {
  return brandEmbed({
    color: 0x5865f2,
    title: `Hola! Soy ${client.user.username}`,
    description: 'Bot de moderación y comunidad de Trigger. Acá tenés todo lo que sé hacer, por categoría:',
    fields: [
      {
        name: 'Información',
        value: '`/userinfo` · `/serverinfo` · `/avatar` · `/status` · `/ping`',
      },
      {
        name: 'Moderación',
        value:
          '`/warn` · `/warnings` · `/quitarnota` · `/kick` · `/ban` · `/unban`\n' +
          '`/softban` · `/timeout` · `/mute` · `/unmute` · `/clear` · `/lockdown` · `/slowmode`',
      },
      {
        name: 'Configuración (staff)',
        value: '`/config` con: `ver` · `welcome` · `modlog` · `logs` · `avisos` · `staff` · `mute` · `ia` · `desactivar`',
      },
      {
        name: 'Niveles y logros',
        value: '`/estadisticas` · `/top` — ganás XP escribiendo, subís de nivel y desbloqueás logros',
      },
      {
        name: 'Utilidades',
        value: '`/afk` · `/encuesta` · `/embed` (staff) · `/plantillas` (staff) · `/frases` (staff)',
      },
      {
        name: 'Diversión',
        value: '`/diversion dado` · `/diversion moneda` · `/diversion beso`',
      },
      {
        name: 'Chat con IA',
        value:
          'Mencioname y charlamos. También entiendo pedidos de moderación en criollo: ' +
          '`@TriggerBOT muteá a @fulano por flodeo` (el staff confirma con un botón).',
      },
    ],
    footer: 'TriggerBOT • usá /help cuando necesites la guía',
  });
}

module.exports = { construirGuia };
