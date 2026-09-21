// Monitoreo de servidores CS 1.6: consulta A2S cada intervalo, alerta al staff cuando
// un server cae o vuelve, y mantiene un panel auto-actualizado en un canal fijo.
//
// Config (config.servidores en store.js, se edita desde /config → Servidores CS 1.6):
//   canalPanel: id del canal donde vive el mensaje del panel
//   mensajePanel: id del mensaje del panel (lo publica /servidores con publicar:true)
//   monitoreo: on/off de las alertas de caída/vuelta (el panel se actualiza siempre)
//   lista: [{ host, puerto, nombre, modo }]
const { brandEmbed, barra } = require('./replies');
const a2s = require('./a2s');
const { getGuildConfig } = require('../store');

const INTERVALO_MS = 90 * 1000; // cada 90 s: fresco sin castigar la cuota de consultas
const MILIS_POR_INTENTOS = 2500; // timeout de cada intento A2S
const INTENTOS = 2; // dos intentos antes de dar un server por caído (UDP pierde paquetes)

// Última instantánea por server (clave "host:puerto") para /servidores e /ip instantáneos.
const cache = new Map();
// Estado de alertas: si ya alertamos que cayó (para no repetir) y si ya avisamos que volvió.
const cayo = new Set();
const volvio = new Set();

function clave(host, puerto) {
  return `${host}:${puerto}`;
}

// Si el server responde con un nombre distinto al configurado, la IP apunta a otro
// server (puerto cambiado, server de otro dueño en la misma máquina, etc.).
function notaDifiere(server, datos) {
  if (!datos?.nombre) return '';
  const normalizar = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalizar(datos.nombre) === normalizar(server.nombre) ? '' : ` ⚠ *el server informa llamarse "${datos.nombre}"*`;
}

// Parsea "cs.nostalgia.ar:27015" o { host, puerto } → [host, puerto].
function parsearDestino(destino) {
  if (typeof destino === 'string') {
    const [host, puertoRaw] = destino.split(':');
    const puerto = Number(puertoRaw) || 27015;
    return [host.trim(), puerto];
  }
  return [String(destino.host), Number(destino.puerto) || 27015];
}

// Consulta con reintentos: devuelve { ok, datos | error, latenciaMs }.
async function consultar(host, puerto) {
  const inicio = Date.now();
  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      const datos = await a2s.consultar(host, puerto, { timeoutMs: MILIS_POR_INTENTOS });
      return { ok: true, datos, latenciaMs: Date.now() - inicio };
    } catch (error) {
      if (intento === INTENTOS) return { ok: false, error: error.message, latenciaMs: Date.now() - inicio };
    }
  }
}

// Un tick: consulta todos los servers de todos los guilds y genera alertas/panel.
async function tick(client) {
  for (const guild of client.guilds.cache.values()) {
    const config = getGuildConfig(guild.id).servidores;
    if (!config?.lista?.length) continue;

    for (const server of config.lista) {
      const [host, puerto] = parsearDestino(server);
      const k = clave(host, puerto);
      const resultado = await consultar(host, puerto);

      if (resultado.ok) {
        cache.set(k, { ...resultado, host, puerto, nombre: server.nombre, modo: server.modo, cuando: Date.now() });
        // Vuelve de una caída: alerta de recuperación (una sola vez).
        if (cayo.has(k) && !volvio.has(k)) {
          volvio.add(k);
          cayo.delete(k);
          if (config.monitoreo !== false) {
            await alertar(guild, embedAlerta(guild, server, 'vuelve', resultado));
          }
        }
      } else {
        // Solo marca caída si teníamos una respuesta previa (evita alertas falsas al arrancar).
        if (cache.has(k) && !cayo.has(k)) {
          cayo.add(k);
          if (config.monitoreo !== false) {
            await alertar(guild, embedAlerta(guild, server, 'cayo', resultado));
          }
        }
        cache.set(k, { ok: false, error: resultado.error, host, puerto, nombre: server.nombre, modo: server.modo, cuando: Date.now() });
      }
    }

    await actualizarPanel(guild, config).catch(() => {});
  }
}

// ---------- Alertas ----------
function canalDeAlertas(guild) {
  const config = getGuildConfig(guild.id);
  return guild.channels.cache.get(config.avisosChannel || config.logs || config.modlog) ?? null;
}

function embedAlerta(guild, server, tipo, resultado) {
  const [host, puerto] = parsearDestino(server);
  const cayoAhora = tipo === 'cayo';

  return brandEmbed({
    color: cayoAhora ? 0xed4245 : 0x57f287,
    title: cayoAhora ? `🔴 ${server.nombre} — cayó` : `🟢 ${server.nombre} — volvió a responder`,
    description:
      `**${host}:${puerto}**\n` +
      (cayoAhora ? `No responde a consultas A2S (${resultado.error}).` : `Ya responde: **${resultado.datos.jugadores}/${resultado.datos.maximo}** en **${resultado.datos.mapa}**.`),
    fields: [{ name: 'IP para conectar', value: `\`${host}:${puerto}\`` }],
    footer: 'TriggerBOT • monitoreo automático de servidores',
  });
}

async function alertar(guild, embed) {
  const canal = canalDeAlertas(guild);
  if (!canal) return;
  await canal.send({ embeds: [embed] }).catch(() => {});
}

// ---------- Panel auto-actualizado ----------
// Redacta el embed del panel con las últimas instantáneas de la config del guild.
// Sin latencia: el ping que mide el bot es desde SU hosting, no representa al jugador
// (suele dar 10x más de lo que la gente ve en el juego y solo genera desconfianza).
function construirPanel(guild, config, instantaneas) {
  const lineas = config.lista.map((server, i) => {
    const [host, puerto] = parsearDestino(server);
    const s = instantaneas.get(clave(host, puerto));
    if (!s) return `⏳ **${server.nombre}**\n> consultando…`;

    if (!s.ok) return `🔴 **${server.nombre}** — caído\n> 🔗 \`${host}:${puerto}\``;

    const d = s.datos;
    const ocup = d.maximo ? d.jugadores / d.maximo : 0;
    const estado = ocup >= 0.9 ? '🔴' : ocup >= 0.6 ? '🟡' : '🟢';
    return (
      `${estado} **${server.nombre}**${notaDifiere(server, d)}\n` +
      `> 👥 ${barra(d.jugadores, d.maximo, 8)} **${d.jugadores}/${d.maximo}** · 🗺️ \`${d.mapa}\`\n` +
      `> 🔗 \`${host}:${puerto}\``
    );
  });

  const totalJugadores = instantaneas.size
    ? [...instantaneas.values()].reduce((sum, s) => sum + (s.ok ? s.datos.jugadores : 0), 0)
    : 0;
  const online = [...instantaneas.values()].filter((s) => s.ok).length;

  const embed = brandEmbed({
    color: online === 0 ? 0xed4245 : online === config.lista.length ? 0x57f287 : 0xfee75c,
    title: '🎮 Servidores TriGGer.Arena — en vivo',
    description: `**${online}/${config.lista.length}** en línea · 👥 **${totalJugadores}** jugando ahora\n\n${lineas.join('\n\n')}`,
    footer: `TriggerBOT • se actualiza solo cada ${Math.round(INTERVALO_MS / 1000)} s`,
  });

  return embed;
}

// Edita el mensaje del panel si existe; si el canal o el mensaje ya no están, no falla.
async function actualizarPanel(guild, config) {
  if (!config.canalPanel || !config.mensajePanel) return;

  const canal = guild.channels.cache.get(config.canalPanel);
  if (!canal?.messages) return;

  // Reúne las últimas instantáneas de los servers de este guild.
  const instantaneas = new Map();
  for (const server of config.lista) {
    const [host, puerto] = parsearDestino(server);
    const s = cache.get(clave(host, puerto));
    if (s) instantaneas.set(clave(host, puerto), s);
  }

  const mensaje = await canal.messages.fetch(config.mensajePanel).catch(() => null);
  if (!mensaje) return;
  const embed = construirPanel(guild, config, instantaneas);
  await mensaje.edit({ embeds: [embed] }).catch(() => {});
}

module.exports = { tick, cache, consultar, parsearDestino, construirPanel, notaDifiere, INTERVALO_MS };
