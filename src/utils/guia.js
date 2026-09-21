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
        value: '`/userinfo` · `/serverinfo` · `/avatar` · `/status` · `/ping`\n*`/ping` y `/status` tienen botón de refrescar, sin reescribir el comando.*',
      },
      {
        name: 'Servidores CS 1.6',
        value: '`/servidores` · `/ip` — estado en vivo, mapa actual e IP para copiar. El staff publica el panel auto-actualizado con `/servidores` → `publicar`.',
      },
      {
        name: 'Moderación',
        value:
          '`/warn` · `/warnings` · `/quitarnota` · `/kick` · `/ban` · `/unban`\n' +
          '`/softban` · `/timeout` · `/mute` · `/unmute` · `/clear` · `/lockdown` · `/slowmode`\n' +
          '*Además: anti-spam y anti-raid automáticos (se prenden en `/config`).*',
      },
      {
        name: 'Configuración (staff)',
        value: '`/config` con: `ver` · `welcome` · `modlog` · `logs` · `avisos` · `staff` · `mute` · `ia` · `proteccion` · `tickets` · `desactivar`',
      },
      {
        name: 'Niveles y logros',
        value:
          '`/estadisticas` · `/logros` · `/top` · `/rolnivel` (staff) — ganás XP escribiendo; racha suma bonus, los findes es x2 y los logros pagan XP.\n' +
          '*`/top` tiene podio y páginas con botones; `/logros` te muestra cuánto falta para cada uno.*',
      },
      {
        name: 'Soporte',
        value: '`/ticket` (staff) — publicá el panel con botón: cada usuario abre su canal privado y al cerrarlo el transcript queda en logs y en su DM.',
      },
      {
        name: 'Utilidades',
        value: '`/afk` · `/encuesta` · `/embed` (staff) · `/plantillas` (staff) · `/frases` (staff)',
      },
      {
        name: 'Diversión y comunidad',
        value:
          '`/beso` · `/abrazo` · `/caricia` · `/abofetear` · `/morder` · `/pellizco` · `/chocar` · `/guino` (con GIFs y contadores)\n' +
          '`/dado` · `/moneda` · `/meme` · `/8ball`',
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
