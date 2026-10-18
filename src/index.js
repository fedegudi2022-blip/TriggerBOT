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
const logComandos = crearLogger('comandos');
const logDiscord = crearLogger('discord');
const logApagado = crearLogger('apagado');
const logSesion = crearLogger('sesion');
const logVigilancia = crearLogger('vigilancia');
const logTempbans = crearLogger('tempbans');
const logXpVoz = crearLogger('xp-voz');
const logStats = crearLogger('stats');
const logCenso = crearLogger('censo');
const logSorteos = crearLogger('sorteos');
const logTickets = crearLogger('tickets');

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

// ---------- Sorteos: cierre automático al vencer ----------
// Cada 30 s cierra los sorteos vencidos, repinta el panel (sin botones) y anuncia a los
// ganadores. La primera pasada va a los 25 s del arranque: si el bot estuvo caído, los
// sorteos que vencieron mientras tanto se cierran enseguida en vez de esperar media hora.
const sorteos = require('./utils/sorteos');
const pasadaDeSorteos = () =>
  sorteos
    .procesar(client)
    .then((resumen) => {
      if (resumen.finalizados) logSorteos.info(`Sorteos cerrados automáticamente: ${resumen.finalizados}`);
      if (resumen.errores) logSorteos.warn(`Sorteos con error al cerrar: ${resumen.errores}`);
    })
    .catch((error) => logSorteos.error('Error en la pasada de sorteos', error));
setInterval(pasadaDeSorteos, 30 * 1000).unref();
setTimeout(pasadaDeSorteos, 25 * 1000).unref();

// ---------- Tickets: auto-cierre por inactividad ----------
// Cada 10 minutos revisa los tickets abiertos: avisa una hora antes de vencer y cierra
// los que superaron el plazo (72 h por defecto, configurable con /ticket inactividad).
// La primera pasada va al minuto: si el bot estuvo caído, los tickets vencidos se
// cierran enseguida en vez de esperar otra pasada.
const ticketsUtil = require('./utils/tickets');
const pasadaDeTickets = () =>
  ticketsUtil
    .procesarInactividad(client)
    .then((resumen) => {
      if (resumen.cerrados) logTickets.info(`Tickets cerrados por inactividad: ${resumen.cerrados}`);
      if (resumen.avisados) logTickets.info(`Tickets avisados antes del cierre automático: ${resumen.avisados}`);
      if (resumen.limpiados) logTickets.info(`Registros de tickets sin canal limpiados: ${resumen.limpiados}`);
      if (resumen.errores) logTickets.warn(`Tickets que no se pudieron cerrar por inactividad: ${resumen.errores}`);
    })
    .catch((error) => logTickets.error('Error en la pasada de auto-cierre de tickets', error));
setInterval(pasadaDeTickets, 10 * 60 * 1000).unref();
setTimeout(pasadaDeTickets, 60 * 1000).unref();

// ---------- Componentes interactivos (botones, selectores y modales) ----------
const { manejarBoton } = require('./utils/accionesIA');
const { responderError } = require('./utils/errores');
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
      // El comando /top expone su render para que el botón pida otra página. El período
      // y la página viajan en el customId (`top:page:2` o `top:page:semana:2`), así que
      // el render los deduce solo.
      await topCmd.ejecutar(interaction);
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
    } else if (interaction.isButton() && interaction.customId.startsWith('sorteo:')) {
      // Participar / Salir de un sorteo (el panel lo publica /sorteo crear).
      await sorteos.manejarBoton(interaction);
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
    // El código (TB-XXXXX) liga lo que ve el usuario con el stack del log.
    await responderError(interaction, error, {
      que: 'procesar este botón',
      contexto: { usuario: interaction.user?.id, guild: interaction.guildId, customId: interaction.customId },
    });
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
    await responderError(interaction, error, {
      que: `ejecutar /${interaction.commandName}`,
      contexto: { comando: interaction.commandName, usuario: interaction.user?.id, guild: interaction.guildId },
    });
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
    await responderError(interaction, error, {
      que: `ejecutar ${interaction.commandName}`,
      contexto: { comando: interaction.commandName, usuario: interaction.user?.id, guild: interaction.guildId },
    });
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
// ---------- Reconexiones ----------
// El log anterior no alcanzaba para diagnosticar: no decía el código de cierre (un
// `event.message` que no existe en ese evento) ni cuántos intentos llevaba. Con el
// código se distingue red del host (1006), token inválido (4004) o mantenimiento de
// Discord. Además se agrupa: una tormenta de reconexiones no llena la consola con la
// misma línea repetida.
let reconexiones = 0;
client.on('shardDisconnect', (event) => {
  const codigo = event?.code ?? '?'; // 1000 = cierre normal · 1006 = red · 4004 = token
  const motivo = event?.reason ? ` (${event.reason})` : '';
  logDiscord.warn(`Conexión perdida con Discord: código ${codigo}${motivo}.`);
  if (codigo === 4004) {
    logDiscord.error('Discord rechazó el token (4004): revisá DISCORD_TOKEN en las variables del hosting.');
  }
});
client.on('shardReconnecting', () => {
  reconexiones += 1;
  // Primera y luego una de cada cinco: suficiente para ver que sigue intentando sin
  // repetir la línea en cada reintento.
  if (reconexiones === 1 || reconexiones % 5 === 0) {
    logDiscord.info(`Reconectando con Discord (intento ${reconexiones})...`);
  }
  // Una ráfaga de reconexiones no es normal: o la red del host está inestable o hay
  // otra instancia del bot con el mismo token peleando por la sesión.
  if (reconexiones === 5) {
    logDiscord.warn('Cinco reconexiones seguidas: revisá la red del host y que no haya otra instancia del bot con el mismo token.');
  }
});
client.on('shardResume', (_id, recuperados) => {
  logDiscord.info(`Conexión reanudada${recuperados ? ` (${recuperados} evento(s) recuperado(s))` : ''}.`);
  reconexiones = 0;
});
client.on('shardReady', () => {
  reconexiones = 0;
});

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
