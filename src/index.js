// TriggerBOT — punto de entrada
// Bot privado para la comunidad Trigger. Persistencia: JSON local + MariaDB como respaldo maestro.

require('dotenv').config();
const { Client, Collection, Partials, MessageFlags } = require('discord.js');
const { intentsDe } = require('./utils/intents');

// ---------- Logger estructurado (nivel, módulo y contexto en cada línea) ----------
const crearLogger = require('./logger');
const log = crearLogger('bot');
const logMonitoreo = crearLogger('monitoreo');
const logFrase = crearLogger('frase');
const logComponentes = crearLogger('componentes');
const logComandos = crearLogger('comandos');
const logDiscord = crearLogger('discord');
const logApagado = crearLogger('apagado');
const logSesion = crearLogger('sesion');
const logVigilancia = crearLogger('vigilancia');
const logTempbans = crearLogger('tempbans');
const logXpVoz = crearLogger('xp-voz');
const logStats = crearLogger('stats');
const logCenso = crearLogger('censo');

// Cooldown por usuario de los comandos (política en un solo lugar: utils/cooldowns.js).
const cooldowns = require('./utils/cooldowns');

// Presence Intent (privilegiado): lo necesitan los canales de estadísticas para contar
// «en línea». Se puede apagar con PRESENCE_INTENT=false, que es la salida cuando la
// aplicación todavía no lo tiene habilitado en el portal: pedir un intent NO habilitado
// hace que Discord cierre la conexión (error «Used disallowed intents») y el bot queda
// reintentando sin arrancar. La decisión vive en utils/intents.js (probada).
const client = new Client({
  intents: intentsDe(),
  partials: [Partials.Channel, Partials.Message],
});

// Buffer de mensajes recientes (para mostrar contenido en los logs de borrados/ediciones).
client.buffersMensajes = new Map();

// ---------- Carga de comandos slash (única fuente: src/commandLoader.js) ----------
// Incluye los directos, los generados por fábrica (/beso, /abrazo...) y /moneda.
// Un módulo roto se saltea y queda anotado (antes tumbaba el arranque entero).
const { cargarComandos, fallosDeCarga } = require('./commandLoader');
client.commands = new Collection();
for (const comando of cargarComandos()) client.commands.set(comando.data.name, comando);

// Lo que no se pudo cargar (comandos + eventos): lo reporta /diag.
client.fallosCarga = fallosDeCarga();

// ---------- Eventos (src/events/*) ----------
// Mismo criterio que con los comandos: si un evento tira al cargarse, el bot sigue
// vivo con el resto. Sin esto, un error de tipeo en un evento dejaba al bot conectado
// pero sordo (no reaccionaba a mensajes ni a entradas de voz).
const eventsPath = require('node:path').join(__dirname, 'events');
const fs = require('node:fs');
for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'))) {
  try {
    const event = require(require('node:path').join(eventsPath, file));
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }
  } catch (error) {
    client.fallosCarga.push({ archivo: `events/${file}`, motivo: error.message });
    logDiscord.error(`No pude cargar events/${file}: ${error.message}`);
  }
}

// ---------- Monitoreo de servidores CS 1.6: alertas de caída y panel en vivo ----------
const { tick: tickServidores, INTERVALO_MS: INTERVALO_SERVIDORES } = require('./utils/monitoreo');
setInterval(() => {
  tickServidores(client).catch((error) => logMonitoreo.error('Error en monitoreo de servidores', error));
}, INTERVALO_SERVIDORES).unref();
// Primer tick tras 15 s de arrancar (deja que Discord termine de conectar).
setTimeout(() => {
  tickServidores(client).catch((error) => logMonitoreo.error('Error en monitoreo de servidores', error));
}, 15_000).unref();

// ---------- Frase del día: publicación diaria a la hora configurada ----------
setInterval(async () => {
  try {
    const { getGuildConfig, setGuildConfig } = require('./store');
    for (const guild of client.guilds.cache.values()) {
      const config = getGuildConfig(guild.id);
      const frase = config.fraseDelDia;
      if (!frase?.canalId || !frase.frases?.length) continue;

      const horaArg = Number(
        new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).format(new Date())
      );
      const diaHoy = new Intl.DateTimeFormat('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
      }).format(new Date());
      if (frase.ultima === diaHoy || horaArg !== frase.hora) continue;

      const canal = guild.channels.cache.get(frase.canalId);
      if (!canal) continue;

      const elegida = frase.frases[Math.floor(Math.random() * frase.frases.length)];
      // El footer no renderiza menciones: resuelve <@ID> → @Nombre.
      let autor = (elegida.autor || 'Anónimo').trim();
      const marca = autor.match(/^<@!?(\d{17,20})>$/);
      if (marca) {
        const miembro = guild.members.cache.get(marca[1]) ?? (await guild.members.fetch(marca[1]).catch(() => null));
        if (miembro) autor = `@${miembro.displayName}`;
      }
      const { brandEmbed, COLORS } = require('./utils/replies');
      await canal
        .send({
          embeds: [
            brandEmbed({
              color: COLORS.info,
              title: 'Frase del día',
              description: `> ${elegida.texto}`,
              footer: `— ${autor} • TriggerBOT`,
            }),
          ],
        })
        .then(() => {
          setGuildConfig(guild.id, (c) => {
            c.fraseDelDia.ultima = diaHoy;
          });
        })
        .catch(() => {});
    }
  } catch (error) {
    logFrase.error('Error en la frase del día', error);
  }
}, 60 * 1000).unref();

// ---------- Vigilancia: avisa al staff cuando algo se degrada ----------
// Revisa IA, base de datos, monitoreo de servidores, canales de voz, conocimiento y
// escrituras pendientes. Solo avisa cuando aparece un problema nuevo (o empeora) y
// cuando se resuelve: no repite el mismo aviso cada 5 minutos.
const { vigilar } = require('./utils/vigilancia');
const INTERVALO_VIGILANCIA_MS = 5 * 60 * 1000;
const pasadaDeVigilancia = () => vigilar(client).catch((error) => logVigilancia.error('Error en la vigilancia', error));
setInterval(pasadaDeVigilancia, INTERVALO_VIGILANCIA_MS).unref();
// Primera pasada a los 2 minutos: deja que la base, el monitoreo y la IA se inicialicen.
setTimeout(pasadaDeVigilancia, 2 * 60 * 1000).unref();

// ---------- Baneos temporales: desbaneo automático al vencer ----------
// Cada minuto revisa los /tempban vencidos, desbanea y cierra el caso. La primera
// pasada va a los 20 s: si el bot estuvo caído, los vencidos se levantan enseguida.
const { procesar: procesarTempbans } = require('./utils/tempbans');
const pasadaDeTempbans = () =>
  procesarTempbans(client).catch((error) => logTempbans.error('Error al desbanear los baneos temporales vencidos', error));
setInterval(pasadaDeTempbans, 60 * 1000).unref();
setTimeout(pasadaDeTempbans, 20 * 1000).unref();

// ---------- XP por voz ----------
// Paga por minuto completo en canal (con anti-abuso: solo, muteado, canal AFK, canales
// excluidos y tope diario). La primera pasada siembra a quien ya estaba conectado cuando
// arrancó el bot, porque esos usuarios no generan evento hasta que se muevan.
const xpVoz = require('./utils/xpVoz');
const pasadaDeVoz = () => xpVoz.pasada(client).catch((error) => logXpVoz.error('Error en la XP por voz', error));
setInterval(pasadaDeVoz, 60 * 1000).unref();
setTimeout(() => {
  xpVoz.sembrar(client);
  pasadaDeVoz();
}, 20 * 1000).unref();

// ---------- Canales de estadísticas del servidor ----------
// Los nombres («👥 Miembros: 87.614») se revisan cada 10 minutos, que es el ritmo que
// permite Discord (2 renombres por canal cada 10 min). La primera pasada va a los 90 s de
// arrancar (después del censo, que sale a los 45 s): si el bot estuvo caído los números
// viejos se corrigen enseguida, y no se escribe «—» en un canal que ya tenía un número real
// solo porque la foto de miembros todavía no llegó.
const stats = require('./utils/estadisticasServer');
const pasadaDeStats = () => stats.refrescar(client).catch((error) => logStats.error('Error al refrescar los canales de estadísticas', error));
setInterval(pasadaDeStats, stats.INTERVALO_MS).unref();
setTimeout(pasadaDeStats, 90 * 1000).unref();

// ---------- Censo de miembros (humanos, bots y gente en línea) ----------
// Una foto completa cada 6 h y los eventos de presencia en el medio (events/presenceUpdate.js).
// Solo se descarga la lista de los servidores que muestran esos números: en un server de
// 87.000 miembros ese fetch no es gratis y no tiene sentido hacerlo para nadie más.
const censo = require('./utils/censo');
const pasadaDeCenso = () =>
  censo
    .revisar(client, { donde: (guild) => stats.activo(guild.id) })
    .then((resumen) => {
      if (resumen.sembrados) {
        for (const datos of censo.estado())
          logCenso.info(`Censo de ${datos.guildId}: ${datos.miembros} miembros, ${datos.bots} bots, ${datos.enLinea ?? 's/d'} en línea`);
      }
    })
    .catch((error) => logCenso.error('Error en el censo de miembros', error));
setInterval(pasadaDeCenso, censo.EDAD_MAXIMA_MS).unref();
// A los 45 s: después de que Discord termine de conectar y antes de la primera pasada de estadísticas.
setTimeout(pasadaDeCenso, 45 * 1000).unref();

// ---------- Componentes interactivos (botones, selectores y modales) ----------
const { manejarBoton } = require('./utils/accionesIA');
const { manejarComponente } = require('./utils/configPanel');
const memeCmd = require('./commands/meme');
const warningsCmd = require('./commands/warnings');
const pingCmd = require('./commands/ping');
const statusCmd = require('./commands/status');
const diagCmd = require('./commands/diag');
const topCmd = require('./commands/top');
const { manejarBotonTicket, manejarModalTicket, manejarSelectTicket } = require('./utils/tickets');
const voz = require('./utils/voz');
const confirmaciones = require('./utils/confirmaciones');
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('conf:')) {
      await confirmaciones.manejarComponente(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('ia_accion:')) {
      await manejarBoton(interaction);
    } else if (interaction.isButton() && interaction.customId === 'meme:otro') {
      await memeCmd.boton(interaction);
    } else if (interaction.isButton() && interaction.customId === 'ping:refresh') {
      await pingCmd.boton(interaction, client);
    } else if (interaction.isButton() && interaction.customId === 'status:refresh') {
      await statusCmd.boton(interaction, client);
    } else if (interaction.isButton() && interaction.customId === 'diag:refresh') {
      await diagCmd.boton(interaction, client);
    } else if (interaction.isButton() && interaction.customId.startsWith('top:page:')) {
      // El comando /top expone su render para que el botón pida otra página.
      await topCmd.ejecutar(interaction, Number(interaction.customId.split(':')[2]) || 1);
    } else if (interaction.isButton() && interaction.customId.startsWith('warnings:')) {
      // Página del historial de advertencias (customId: warnings:<userId>:<pagina>).
      const [, userId, pagina] = interaction.customId.split(':');
      const autor = await interaction.client.users.fetch(userId).catch(() => null);
      if (!autor) {
        await interaction.reply({ content: 'No pude resolver ese usuario.', flags: MessageFlags.Ephemeral });
      } else {
        await warningsCmd.ejecutar(interaction, autor, Number(pagina) || 1);
      }
    } else if (interaction.isButton() && interaction.customId.startsWith('ticket:')) {
      await manejarBotonTicket(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('voz:')) {
      await voz.manejarComponente(interaction);
    } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket:')) {
      // Selector de tipo de ticket del panel de /ticket publicar.
      await manejarSelectTicket(interaction);
    } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('voz:sel:')) {
      await voz.manejarSelect(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('voz:modal:')) {
      await voz.manejarModal(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:')) {
      await manejarModalTicket(interaction);
    } else if (interaction.customId?.startsWith('cfg:')) {
      await manejarComponente(interaction);
    }
  } catch (error) {
    logComponentes.error('Error en componente interactivo', error);
    const payload = { content: 'Ocurrió un error con el panel.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// ---------- Autocompletado ----------
// Los comandos exponen `autocomplete(interaction)` (motivos de /warn, plantillas,
// nombres de comando de /help). Sin este handler, Discord mostraba el selector pero
// la respuesta nunca llegaba: el autocompletado estaba muerto.
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command?.autocomplete) return;
  try {
    await command.autocomplete(interaction);
  } catch (error) {
    logComandos.error(`Error en autocompletado de /${interaction.commandName}`, error, { comando: interaction.commandName });
    await interaction.respond([]).catch(() => {});
  }
});

// ---------- Manejador de comandos slash ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  // Anti-abuso: un uso por usuario cada `command.cooldown` segundos (2 por defecto).
  // Va acá y no dentro de cada comando para que la política viva en un solo lugar y
  // ningún comando nuevo nazca sin límite; los que salen a la red declaran más.
  const bloqueo = cooldowns.esperar(command.data.name, interaction.user.id, command.cooldown);
  if (bloqueo) {
    return interaction.reply({ content: cooldowns.aviso(command.data.name, bloqueo.restante), flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  try {
    await command.execute(interaction, client);
  } catch (error) {
    logComandos.error(`Error en /${interaction.commandName}`, error, { comando: interaction.commandName });
    const payload = { content: 'Ocurrió un error al ejecutar el comando.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// ---------- Comandos de menú contextual (click derecho sobre un usuario) ----------
// Comparten el mapa de comandos con los slash (mismo nombre, otro tipo), así que el
// mismo registro los resuelve; cambia solo cómo llega la interacción.
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isUserContextMenuCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    logComandos.error(`Error en el comando contextual ${interaction.commandName}`, error, { comando: interaction.commandName });
    const payload = { content: 'Ocurrió un error al ejecutar el comando.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// ---------- Errores globales (evita caídas por promesas rechazadas) ----------
process.on('unhandledRejection', (error) => log.error('Promesa rechazada no manejada', error));

// ---------- Registro de eventos de conexión ----------
client.on('error', (error) => {
  const mensaje = String(error?.message ?? '');
  // Error 4014: la aplicación pide un intent privilegiado que no tiene habilitado. El
  // reintento cada 60 s se encarga del resto: apenas se prende el interruptor en el
  // portal, la conexión siguiente entra sin tocar nada.
  if (/disallowed intents/i.test(mensaje)) {
    logDiscord.error(
      'Discord rechazó la conexión: el bot pide el Presence Intent y la aplicación no lo tiene habilitado. ' +
        'Habilitalo en https://discord.com/developers/applications → Bot → Privileged Gateway Intents → Presence Intent, ' +
        'o poné PRESENCE_INTENT=false en las variables del hosting para arrancar sin contar «en línea».'
    );
    return;
  }
  logDiscord.error('Error en la conexión con Discord', error);
});
client.on('shardDisconnect', (event) => logDiscord.warn(`Conexión perdida con Discord. Reintentando automáticamente... ${event?.message ?? ''}`));
client.on('shardReconnecting', () => logDiscord.info('Reconectando con Discord...'));

// ---------- Apagado controlado (SIGTERM/SIGINT: Wispbyte, Ctrl+C, etc.) ----------
// Orden: 1) bloquear nuevas señales, 2) volcar a disco los JSON pendientes,
// 3) esperar subidas a la base, 4) cerrar Discord y la BD, 5) salir.
let apagando = false;
async function apagadoControlado(señal) {
  if (apagando) return;
  apagando = true;
  logApagado.info(`Recibí ${señal}: iniciando apagado controlado...`);
  try {
    puente.detener();
  } catch {
    /* el puente quizá nunca arrancó */
  }
  try {
    const { volcarTodo, esperarSubidasPendientes } = require('./db/sync');
    volcarTodo();
    await esperarSubidasPendientes();
  } catch (error) {
    logApagado.error('Error al volcar datos en el apagado', error);
  }
  try {
    await client.destroy();
  } catch (error) {
    logApagado.error('Error al cerrar Discord', error);
  }
  try {
    const { cerrar } = require('./db/mariadb');
    await cerrar();
  } catch (error) {
    logApagado.error('Error al cerrar la base de datos', error);
  }
  logApagado.info('Apagado completado. ¡Hasta la próxima!');
  process.exit(0);
}
process.on('SIGTERM', () => apagadoControlado('SIGTERM'));
process.on('SIGINT', () => apagadoControlado('SIGINT'));

// ---------- Puente web ↔ bot (base MariaDB como bus de comandos) ----------
// La web TriGGer.Arena encola comandos en la tabla bot_cmd y lee el estado
// que este módulo publica. Requiere DB_HOST + DB_NAME + DB_USER configuradas.
const puente = require('./db/puente');
const { Events } = require('discord.js');
client.once(Events.ClientReady, () => {
  puente.iniciar(client);
});

// ---------- Inicio de sesión con reintentos automáticos ----------
let intentos = 0;

function iniciarSesion() {
  intentos += 1;
  let respondio = false;

  // Si Discord no responde en 45 s (típico de un bloqueo de IP del nodo), se reintenta.
  const vigilante = setTimeout(() => {
    if (respondio) return;
    logSesion.warn(
      `Sin respuesta de Discord tras 45 s (intento ${intentos}). ` + 'Causa probable: bloqueo temporal de la IP del nodo. Nuevo intento en 60 s.'
    );
    client.destroy().catch(() => {});
    setTimeout(iniciarSesion, 60_000);
  }, 45_000);

  client
    .login(process.env.DISCORD_TOKEN)
    .then(() => {
      respondio = true;
      clearTimeout(vigilante);
    })
    .catch((error) => {
      clearTimeout(vigilante);
      respondio = true;
      const mensaje = String(error?.message || error);
      if (/token/i.test(mensaje)) {
        logSesion.error(
          'ERROR CRÍTICO: token inválido o no definido. ' +
            'Verifique la variable DISCORD_TOKEN en el panel (Startup → Variables) y reinicie el servidor.'
        );
        process.exit(1);
      }
      logSesion.warn(`Fallo de conexión con Discord (intento ${intentos}): ${mensaje}. Nuevo intento en 60 s.`);
      client.destroy().catch(() => {});
      setTimeout(iniciarSesion, 60_000);
    });
}

log.info('Inicializando TriggerBOT v1.0');
iniciarSesion();
