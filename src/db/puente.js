// Puente web ↔ bot vía la base de datos de la web (MariaDB, trigger-arena-db).
//
// La web (TriGGer.Arena) y el bot comparten la MISMA base MariaDB. La web
// inserta filas en la tabla `bot_cmd` ("publicar anuncio", "cambiar canales",
// "apagar protección"...) y este módulo las consulta cada 5 segundos, las
// ejecuta con TODAS las validaciones normales del bot y guarda el resultado.
// Además publica el estado del bot (ping, servidores, memoria) en una fila
// especial `bot_estado:_global` de `bot_data`, que la web lee para su panel.
//
// Ventajas: no hay puertos abiertos, ni URLs expuestas, ni tokens nuevos —
// la autenticación es el usuario MySQL de la base que cada lado ya tiene.
// Latencia típica: 3-5 segundos (el intervalo del tick), perfecto para un panel.
//
// Comandos aceptados (whitelist estricta; todo lo demás se rechaza):
//   recargar_config   → fuerza al bot a releer su config (no-op útil tras ediciones)
//   publicar_anuncio  → envía un embed de la web a un canal del server
//   set_canales       → cambia canales configurados (modlog, logs, avisos, niveles, bienvenida)
//   set_mute_role     → cambia el rol de silenciado
//   set_proteccion    → ajusta anti-spam/anti-raid (solo claves y rangos validados)
//   set_ia            → activa/desactiva el chat con IA
//
// Los cambios de config usan store.setGuildConfig(): el sync a la base y las
// marcas por guild se disparan solos, como cualquier edición desde /config.

const { subir, listarTabla, actualizar, estado } = require('./mariadb');
const { setGuildConfig } = require('../store');
const crearLogger = require('../logger');
const log = crearLogger('puente');

const INTERVALO_MS = 5_000; // cada cuánto consulta comandos y publica estado
const EDAD_MAXIMA_MS = 60_000; // filas más viejas sin procesar se saltan (comando vencido)
const MAX_POR_TICK = 10; // tope de comandos por tick (protección contra spam de la web)

// ---------- Whistelist y validación de argumentos ----------

// Canales que la web puede cambiar: clave del comando → clave de config del bot.
const CLAVES_CANALES = new Set(['modlog', 'logs', 'avisos', 'canalNiveles', 'bienvenida']);
const ACCIONES_SPAM = new Set(['aviso', 'timeout', 'mute', 'kick', 'ban']);
const ACCIONES_RAID = new Set(['nada', 'kick', 'ban']);
const CLAVES_PROTECCION_INT = new Set(['spamMensajes', 'spamSegundos', 'raidJoins', 'raidSegundos']);

function esSnowflake(v) {
  return typeof v === 'string' && /^\d{5,25}$/.test(v);
}

function enteroEnRango(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Ejecuta un comando de la web. `fila` = { comando, argumentos, guild_id }.
// Devuelve { ok, detalle?, error? } con lo que REALMENTE pasó.
async function procesarFila(fila, client) {
  const comando = String(fila.comando || '');
  const args = fila.argumentos && typeof fila.argumentos === 'object' ? fila.argumentos : {};
  const guildId = String(fila.guild_id || '');

  if (!client.isReady()) return { ok: false, error: 'El bot todavía está conectando con Discord' };

  // Comandos globales (sin server).
  if (comando === 'recargar_config') {
    return { ok: true, detalle: 'config releída (los almacenes ya se actualizan en vivo)' };
  }

  // El resto de comandos requieren un server destino.
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, error: `El bot no está en el servidor ${guildId || '(sin ID)'}` };

  switch (comando) {
    case 'publicar_anuncio': {
      const canalId = String(args.canal_id || '');
      const texto = String(args.mensaje || '').trim();
      if (!esSnowflake(canalId)) return { ok: false, error: 'canal_id inválido' };
      if (!texto) return { ok: false, error: 'mensaje vacío' };
      const canal = guild.channels.cache.get(canalId);
      if (!canal?.send) return { ok: false, error: `El canal ${canalId} no existe o no acepta mensajes` };
      const { brandEmbed } = require('../utils/replies');
      await canal.send({
        embeds: [
          brandEmbed({
            color: 0x5865f2,
            title: String(args.titulo || '📣 Anuncio').slice(0, 256),
            description: texto.slice(0, 4000),
            footer: 'Enviado desde TriGGer.Arena • TriggerBOT',
          }),
        ],
      });
      return { ok: true, detalle: `anuncio enviado a #${canal.name}` };
    }

    case 'set_canales': {
      const cambios = [];
      setGuildConfig(guildId, (c) => {
        for (const [clave, valor] of Object.entries(args)) {
          if (!CLAVES_CANALES.has(clave) || !esSnowflake(String(valor))) continue;
          if (clave === 'bienvenida') {
            c.welcome = c.welcome || {};
            c.welcome.channelId = String(valor);
          } else {
            c[clave] = String(valor);
          }
          cambios.push(clave);
        }
      });
      if (!cambios.length) return { ok: false, error: 'ningún canal válido en los argumentos' };
      return { ok: true, detalle: `canales actualizados: ${cambios.join(', ')}` };
    }

    case 'set_mute_role': {
      const rolId = String(args.rol_id || '');
      if (!esSnowflake(rolId)) return { ok: false, error: 'rol_id inválido' };
      setGuildConfig(guildId, (c) => {
        c.muteRole = rolId;
      });
      return { ok: true, detalle: 'rol de silenciado actualizado' };
    }

    case 'set_proteccion': {
      const cambios = [];
      setGuildConfig(guildId, (c) => {
        const prot = { ...(c.proteccion || {}) };
        if (typeof args.activado === 'boolean') {
          prot.activado = args.activado;
          cambios.push(`activado=${args.activado}`);
        }
        if (ACCIONES_SPAM.has(args.accionSpam)) {
          prot.accionSpam = args.accionSpam;
          cambios.push(`accionSpam=${args.accionSpam}`);
        }
        if (ACCIONES_RAID.has(args.accionRaid)) {
          prot.accionRaid = args.accionRaid;
          cambios.push(`accionRaid=${args.accionRaid}`);
        }
        for (const clave of CLAVES_PROTECCION_INT) {
          const n = enteroEnRango(args[clave], 1, 1000);
          if (n !== null) {
            prot[clave] = n;
            cambios.push(`${clave}=${n}`);
          }
        }
        if (typeof args.accionesRapidas === 'boolean') {
          prot.accionesRapidas = args.accionesRapidas;
          cambios.push(`accionesRapidas=${args.accionesRapidas}`);
        }
        c.proteccion = prot;
      });
      if (!cambios.length) return { ok: false, error: 'ningún ajuste válido de protección' };
      return { ok: true, detalle: `protección: ${cambios.join(', ')}` };
    }

    case 'set_ia': {
      if (typeof args.activada !== 'boolean') return { ok: false, error: 'falta activada=true/false' };
      setGuildConfig(guildId, (c) => {
        c.iaActivada = args.activada;
      });
      return { ok: true, detalle: `chat con IA ${args.activada ? 'activado' : 'desactivado'}` };
    }

    default:
      return { ok: false, error: `comando desconocido: ${comando}` };
  }
}

// ---------- Estado del bot (lo lee la web) ----------
function estadoBot(client) {
  let pingMs = null;
  try {
    const p = Math.round(client.ws.ping);
    if (Number.isFinite(p) && p >= 0) pingMs = p;
  } catch {
    /* sin websocket aún */
  }
  const guilds = [];
  for (const g of client.guilds?.cache?.values() ?? []) {
    guilds.push({ id: g.id, nombre: g.name, miembros: g.memberCount ?? null });
  }
  return {
    online: Boolean(client.isReady?.()),
    pingMs,
    servidores: guilds.length,
    guilds,
    comandos: client.commands?.size ?? 0,
    uptimeSeg: Math.floor(process.uptime()),
    memoriaMb: Math.round(process.memoryUsage().rss / 1048576),
    versionNodo: process.version,
    ultimaRevision: new Date().toISOString(),
  };
}

// ---------- Tick: procesar comandos + publicar estado ----------
async function tick(client) {
  if (!estado.configurada) return;

  // 1) Comandos pendientes de la web.
  try {
    const pendientes = await listarTabla('bot_cmd', {
      select: 'id,comando,guild_id,argumentos,creado_en',
      filtros: { procesado_en: 'is.null' },
      orden: 'creado_en.asc',
      limite: MAX_POR_TICK,
    });
    const ahora = Date.now();

    for (const fila of pendientes) {
      let resultado;
      const vencido = ahora - new Date(fila.creado_en).getTime() > EDAD_MAXIMA_MS;
      if (vencido) {
        resultado = { ok: false, error: 'comando vencido (esperó más de 60 s)' };
      } else {
        try {
          resultado = await procesarFila(fila, client);
        } catch (error) {
          resultado = { ok: false, error: error?.message || String(error) };
          log.error('Error ejecutando comando de la web', error, { comando: fila.comando, guild: fila.guild_id });
        }
      }
      await actualizar('bot_cmd', { id: String(fila.id) }, {
        procesado_en: new Date().toISOString(),
        resultado,
      });
      log.info(
        `Comando web "${fila.comando}" → ${resultado.ok ? 'OK' : 'fallo'}` +
        (resultado.detalle ? `: ${resultado.detalle}` : resultado.error ? `: ${resultado.error}` : '')
      );
    }
  } catch (error) {
    log.error('No se pudieron leer los comandos de la web', error);
  }

  // 2) Publicar el estado (fila especial de bot_data; la web la lee).
  try {
    await subir('bot_estado:_global', '_global', 'bot_estado', estadoBot(client));
  } catch (error) {
    log.error('No se pudo publicar el estado', error);
  }
}

// ---------- Ciclo de vida (lo usa index.js) ----------
let timer = null;
let ocupado = false;

function iniciar(client) {
  if (timer || !estado.configurada) return;
  timer = setInterval(() => {
    if (ocupado) return; // el tick anterior todavía corre: no acumular
    ocupado = true;
    tick(client)
      .catch(() => {})
      .finally(() => {
        ocupado = false;
      });
  }, INTERVALO_MS);
  timer.unref?.();
  log.info(`Puente web activo: comandos cada ${INTERVALO_MS / 1000} s`);
}

function detener() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { iniciar, detener, tick, procesarFila, estadoBot };
