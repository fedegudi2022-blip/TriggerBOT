const { brandEmbed } = require('./replies');

// Guía del bot organizada por categorías, con el estilo visual unificado.
// Hay dos versiones: la pública (que ven todos con /help) y la de staff
// (completa, solo accesible con /help staff por quien tenga rol de staff).

// ---------- Campos compartidos por ambas guías (solo cosas de usuario) ----------
function camposPublicos() {
  return [
    {
      name: 'Información',
      value: '`/userinfo` · `/serverinfo` · `/avatar` · `/status` · `/ping`\n*`/ping` y `/status` tienen botón de refrescar, sin reescribir el comando.*',
    },
    {
      name: 'Comunidad',
      value: '`/redes` · `/web` — redes sociales oficiales (WhatsApp, Steam, Instagram) y el sitio triggerarena.pro, con botones directos.\n`/voz` — canales de voz temporales: entrá al canal «➕ Crear canal» y se te crea tu «🔊 Canal de Voz de (usuario)» con controles.',
    },
    {
      name: 'Servidores CS 1.6',
      value: '`/servidores` · `/ip` — estado en vivo, mapa actual e IP para copiar.',
    },
    {
      name: 'Niveles y logros',
      value:
        '`/estadisticas` · `/logros` · `/top` — ganás XP escribiendo; racha suma bonus, los findes es x2 y los logros pagan XP.\n' +
        '*`/top` tiene podio y páginas con botones; `/logros` te muestra cuánto falta para cada uno.*',
    },
    {
      name: 'Soporte',
      value: 'Si necesitás hablar con el staff, usá el panel de tickets: apretás el botón 📨 y se te crea un canal privado solo para vos y el equipo.',
    },
    {
      name: 'Utilidades',
      value: '`/afk` · `/encuesta`',
    },
    {
      name: 'Diversión y comunidad',
      value:
        '`/beso` · `/abrazo` · `/caricia` · `/abofetear` · `/morder` · `/pellizco` · `/chocar` · `/guino` (con GIFs y contadores)\n' +
        '`/dado` · `/moneda` · `/meme` · `/8ball`',
    },
    {
      name: 'Chat con IA',
      value: 'Mencioname y charlamos de lo que quieras. 🤖',
    },
  ];
}

// ---------- Campos solo para staff (moderación, config y utilidades internas) ----------
function camposStaff() {
  return [
    {
      name: 'Comunidad (staff)',
      value: '`/voz` (staff activa) — activá los canales de voz temporales para la comunidad.',
    },
    {
      name: 'Servidores CS 1.6 (staff)',
      value: '`/servidores` → `publicar` — publicás el panel auto-actualizado en el canal que quieras.',
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
      name: 'Niveles y logros (staff)',
      value: '`/rolnivel` — configurás los roles que se dan por nivel de XP.',
    },
    {
      name: 'Soporte (staff)',
      value: '`/ticket` — publicás el panel con botón: cada usuario abre su canal privado y al cerrarlo el transcript queda en logs y en su DM.',
    },
    {
      name: 'Utilidades (staff)',
      value: '`/embed` · `/plantillas` · `/frases`',
    },
    {
      name: 'Chat con IA (staff)',
      value:
        'Además de charlar, entiendo pedidos de moderación en criollo: ' +
        '`@TriggerBOT muteá a @fulano por flodeo` (confirmás con un botón).',
    },
  ];
}

// Guía pública: la ve cualquiera con /help. Sin comandos ni detalles de staff.
function construirGuia(client) {
  return brandEmbed({
    color: 0x5865f2,
    title: `Hola! Soy ${client.user.username}`,
    description: 'Bot de la comunidad de Trigger. Acá tenés lo que podés usar, por categoría:',
    fields: camposPublicos(),
    footer: 'TriggerBOT • usá /help cuando necesites la guía',
  });
}

// Guía completa: todo lo de la pública + todo lo de staff. Solo con /help staff.
function construirGuiaStaff(client) {
  return brandEmbed({
    color: 0x5865f2,
    title: `Guía completa de ${client.user.username} (staff)`,
    description: 'Todo lo que sé hacer, incluida la parte de moderación y configuración:',
    fields: [...camposPublicos(), ...camposStaff()],
    footer: 'TriggerBOT • guía de staff, no la compartas en canales públicos',
  });
}

module.exports = { construirGuia, construirGuiaStaff };
