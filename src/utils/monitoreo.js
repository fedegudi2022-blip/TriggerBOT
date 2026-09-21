// Monitoreo de servidores CS 1.6: consulta A2S cada intervalo, alerta al staff cuando
// un server cae o vuelve, y mantiene un panel auto-actualizado en un canal fijo.
//
// Config (config.servidores en store.js, se edita desde /config → Servidores CS 1.6):
//   canalPanel: id del canal donde vive el mensaje del panel
//   mensajePanel: id del mensaje del panel (lo publica /servidores con publicar:true)
//   monitoreo: on/off de las alertas de caída/vuelta (el panel se actualiza siempre)
//   lista: [{ host, puerto, nombre, modo }]
const { brandEmbed } = require('./replies');
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

// Si el server responde con un nombre totalmente distinto al configurado, la IP apunta
// a otro server (puerto cambiado, server de otro dueño en la misma máquina, etc.).
// La comparación es tolerante: considera el mismo server si comparten al menos la mitad
// de las palabras ("AutoMix" vs "MIX" o "KZ+Bhop 100aa" vs "KZ+Bhop" no generan aviso;
// "ARGENTINA CS SOLO DUST2" configurado como "~|PUBLICO|~" sí).
function palabrasDe(nombre) {
  return String(nombre)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // sin acentos: PÚBLICO == publico
    .split(/[^a-z]+/)
    .filter((p) => p.length >= 3);
}

function nombresCompatibles(configurado, reportado) {
  const a = palabrasDe(configurado);
  const b = palabrasDe(reportado);
  if (!a.length || !b.length) return true; // sin datos para comparar: no advierte
  const coincidencias = a.filter((p) => b.includes(p)).length;
  return coincidencias / a.length >= 0.5;
}

function notaDifiere(server, datos) {
  if (!datos?.nombre) return '';
  if (nombresCompatibles(server.nombre, datos.nombre)) return '';
  return ` ⚠ *el server informa llamarse "${datos.nombre}" — verificá que la IP sea la correcta*`;
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
// Una tarjeta por server, al estilo de la ficha de triggerarena.pro: nombre como título,
// descripción del modo, Estado/Jugadores/Mapa en columnas, la IP en su propia fila y el
// "Última actualización" en el footer (Discord lo renderiza del timestamp del embed).
// Sin latencia: el ping que mide el bot es desde SU hosting, no representa al jugador.
function descripcionDe(server) {
  return (
    server.descripcion?.trim() ||
    (server.modo ? `Modo **${server.modo}** de Counter-Strike 1.6.` : 'Server de Counter-Strike 1.6 de la comunidad TriGGer.Arena.')
  );
}

// La tarjeta de un server con su instantánea (s puede ser undefined = todavía sin datos).
function tarjetaServidor(server, host, puerto, s) {
  const base = descripcionDe(server);

  if (!s) {
    return brandEmbed({
      color: 0x5865f2,
      title: server.nombre,
      description: `${base}\n\n⏳ Consultando estado…`,
      thumbnail: server.imagen || undefined,
      footer: 'TriGGer.Arena • Última actualización',
    });
  }

  if (!s.ok) {
    return brandEmbed({
      color: 0xed4245,
      title: server.nombre,
      description: base,
      thumbnail: server.imagen || undefined,
      fields: [
        { name: 'Estado', value: '🔴 Caído', inline: true },
        { name: 'Jugadores', value: '—', inline: true },
        { name: 'Mapa actual', value: '—', inline: true },
        { name: 'IP del servidor', value: `\`${host}:${puerto}\``, inline: false },
      ],
      footer: 'TriGGer.Arena • Última actualización',
    });
  }

  const d = s.datos;
  const ocup = d.maximo ? d.jugadores / d.maximo : 0;
  const estado = ocup >= 0.9 ? '🔴 Online (lleno)' : '🟢 Online';
  const aviso = notaDifiere(server, d);

  return brandEmbed({
    color: 0x5865f2,
    title: server.nombre,
    description: base + (aviso ? `\n\n${aviso.trim()}` : ''),
    thumbnail: server.imagen || undefined,
    fields: [
      { name: 'Estado', value: estado, inline: true },
      { name: 'Jugadores', value: `**${d.jugadores}/${d.maximo}**`, inline: true },
      { name: 'Mapa actual', value: `\`${d.mapa}\``, inline: true },
      { name: 'IP del servidor', value: `\`${host}:${puerto}\``, inline: false },
    ],
    footer: 'TriGGer.Arena • Última actualización',
  });
}

// El panel completo: hasta 10 tarjetas (límite de embeds por mensaje de Discord).
function construirPanel(guild, config, instantaneas) {
  return config.lista.slice(0, 10).map((server) => {
    const [host, puerto] = parsearDestino(server);
    return tarjetaServidor(server, host, puerto, instantaneas.get(clave(host, puerto)));
  });
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
  await mensaje.edit({ embeds: construirPanel(guild, config, instantaneas) }).catch(() => {});
}

module.exports = { tick, cache, consultar, parsearDestino, construirPanel, tarjetaServidor, notaDifiere, nombresCompatibles, INTERVALO_MS };
