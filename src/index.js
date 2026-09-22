// TriggerBOT — punto de entrada
// Bot privado para la comunidad Trigger. Persistencia: JSON local + MariaDB como respaldo maestro.

require('dotenv').config();
const { Client, Collection, GatewayIntentBits, Partials, MessageFlags } = require('discord.js');

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Buffer de mensajes recientes (para mostrar contenido en los logs de borrados/ediciones).
client.buffersMensajes = new Map();

// ---------- Carga de comandos slash (única fuente: src/commandLoader.js) ----------
// Incluye los directos, los generados por fábrica (/beso, /abrazo...) y /moneda.
const { cargarComandos } = require('./commandLoader');
client.commands = new Collection();
for (const comando of cargarComandos()) client.commands.set(comando.data.name, comando);

// ---------- Eventos (src/events/*) ----------
const eventsPath = require('node:path').join(__dirname, 'events');
const fs = require('node:fs');
for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'))) {
  const event = require(require('node:path').join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
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
      const diaHoy = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date());
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
      const { brandEmbed } = require('./utils/replies');
      await canal
        .send({
          embeds: [
            brandEmbed({
              color: 0x5865f2,
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

// ---------- Componentes interactivos (botones, selectores y modales) ----------
const { manejarBoton } = require('./utils/accionesIA');
const { manejarComponente } = require('./utils/configPanel');
const memeCmd = require('./commands/meme');
const pingCmd = require('./commands/ping');
const statusCmd = require('./commands/status');
const topCmd = require('./commands/top');
const { manejarBotonTicket, manejarModalTicket } = require('./utils/tickets');
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('ia_accion:')) {
      await manejarBoton(interaction);
    } else if (interaction.isButton() && interaction.customId === 'meme:otro') {
      await memeCmd.boton(interaction);
    } else if (interaction.isButton() && interaction.customId === 'ping:refresh') {
      await pingCmd.boton(interaction, client);
    } else if (interaction.isButton() && interaction.customId === 'status:refresh') {
      await statusCmd.boton(interaction, client);
    } else if (interaction.isButton() && interaction.customId.startsWith('top:page:')) {
      // El comando /top expone su render para que el botón pida otra página.
      await topCmd.ejecutar(interaction, Number(interaction.customId.split(':')[2]) || 1);
    } else if (interaction.isButton() && interaction.customId.startsWith('ticket:')) {
      await manejarBotonTicket(interaction);
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

// ---------- Manejador de comandos slash ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    logComandos.error(`Error en /${interaction.commandName}`, error, { comando: interaction.commandName });
    const payload = { content: '❌ Ocurrió un error al ejecutar el comando.', flags: MessageFlags.Ephemeral };
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
client.on('error', (error) => logDiscord.error('Error en la conexión con Discord', error));
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
      `Sin respuesta de Discord tras 45 s (intento ${intentos}). ` +
      'Causa probable: bloqueo temporal de la IP del nodo. Nuevo intento en 60 s.'
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
      logSesion.warn(
        `Fallo de conexión con Discord (intento ${intentos}): ${mensaje}. Nuevo intento en 60 s.`
      );
      client.destroy().catch(() => {});
      setTimeout(iniciarSesion, 60_000);
    });
}

log.info('Inicializando TriggerBOT v1.0');
iniciarSesion();
