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
//   recargar_config    → fuerza al bot a releer su config (no-op útil tras ediciones)
//   publicar_anuncio   → envía un embed de la web a un canal del server
//   set_canales        → cambia canales configurados (modlog, logs, avisos, niveles, bienvenida)
//   set_mute_role      → cambia el rol de silenciado
//   set_proteccion     → ajusta anti-spam/anti-raid (solo claves y rangos validados)
//   set_ia             → activa/desactiva el chat con IA
//   set_config         → esquema único (ESQUEMA_CONFIG) para TODA la config: la web
//                        manda { campo: valor } y el bot valida y aplica cada campo
//   agregar_frase      → suma una frase al rotativo de la frase del día
//   quitar_frase       → elimina la frase #numero
//   agregar_server_cs  → agrega un server CS 1.6 al panel (/servidores)
//   quitar_server_cs   → elimina el server #numero
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
const MAX_CANALES_ESTADO = 500; // tope de canales por guild en el estado publicado
const MAX_ROLES_ESTADO = 250; // tope de roles por guild en el estado publicado
const MAX_TEXTOS = 300; // tope de caracteres para textos de la web (frases, nombres, etc.)

// ---------- Whistelist y validación de argumentos ----------

// Canales que la web puede cambiar: clave del comando → clave de config del bot.
const CLAVES_CANALES = new Set(['modlog', 'logs', 'avisos', 'canalNiveles', 'bienvenida']);
const ACCIONES_SPAM = new Set(['aviso', 'timeout', 'mute', 'kick', 'ban']);
const ACCIONES_RAID = new Set(['nada', 'kick', 'ban']);
const CLAVES_PROTECCION_INT = new Set(['spamMensajes', 'spamSegundos', 'raidJoins', 'raidSegundos']);

// ---------- Esquema de TODA la config editable desde la web ----------
// set_config valida cada campo contra acá. Agregar un ajuste nuevo = una línea.
// tipos: 'snowflake' (canal/rol), 'int' (min/max), 'bool', 'enum' (valores), 'string' (max).
// rol: 'admin'|'mod'|'helper'|'mute' → escribe c[`${rol}Role`] / c.muteRole.
// ruta: clave anidada ('welcome.channelId'); sin ruta → campo suelto de la config.
const ESQUEMA_CONFIG = {
  bienvenida: { ruta: 'welcome.channelId', tipo: 'snowflake' },
  autorol: { rol: 'autorol', tipo: 'snowflake' },
  modlog: { tipo: 'snowflake' },
  logs: { tipo: 'snowflake' },
  avisosChannel: { tipo: 'snowflake' },
  canalNiveles: { tipo: 'snowflake' },
  canalFrases: { ruta: 'fraseDelDia.canalId', tipo: 'snowflake' },
  horaFrases: { ruta: 'fraseDelDia.hora', tipo: 'int', min: 0, max: 23 },
  adminRole: { rol: 'admin', tipo: 'snowflake' },
  modRole: { rol: 'mod', tipo: 'snowflake' },
  helperRole: { rol: 'helper', tipo: 'snowflake' },
  muteRole: { rol: 'mute', tipo: 'snowflake' },
  iaActivada: { tipo: 'bool' },
  proteccionActivada: { ruta: 'proteccion.activado', tipo: 'bool' },
  accionSpam: { ruta: 'proteccion.accionSpam', tipo: 'enum', valores: [...ACCIONES_SPAM] },
  accionRaid: { ruta: 'proteccion.accionRaid', tipo: 'enum', valores: [...ACCIONES_RAID] },
  spamMensajes: { ruta: 'proteccion.spamMensajes', tipo: 'int', min: 3, max: 20 },
  spamSegundos: { ruta: 'proteccion.spamSegundos', tipo: 'int', min: 2, max: 120 },
  raidJoins: { ruta: 'proteccion.raidJoins', tipo: 'int', min: 3, max: 50 },
  raidSegundos: { ruta: 'proteccion.raidSegundos', tipo: 'int', min: 10, max: 600 },
  accionesRapidas: { ruta: 'proteccion.accionesRapidas', tipo: 'bool' },
  ticketsCategoria: { ruta: 'tickets.categoriaId', tipo: 'snowflake' },
  ticketsLogs: { ruta: 'tickets.canalLogs', tipo: 'snowflake' },
  welcomeMessage: { ruta: 'welcome.message', tipo: 'string', max: 1000 },
  servidoresAlertas: { ruta: 'servidores.monitoreo', tipo: 'bool' },
};

// Valida un valor crudo contra el esquema. Devuelve el valor saneado o null si es inválido.
function validarContraEsquema(regla, valor) {
  switch (regla.tipo) {
    case 'snowflake':
      return esSnowflake(String(valor)) ? String(valor) : null;
    case 'int': {
      if (typeof valor === 'boolean') return null;
      const n = Math.round(Number(valor));
      return Number.isFinite(n) && n >= (regla.min ?? -Infinity) && n <= (regla.max ?? Infinity) ? n : null;
    }
    case 'bool':
      if (typeof valor === 'boolean') return valor;
      if (valor === 'true' || valor === 1) return true;
      if (valor === 'false' || valor === 0) return false;
      return null;
    case 'enum':
      return regla.valores.includes(valor) ? valor : null;
    case 'string': {
      if (typeof valor !== 'string' && typeof valor !== 'number') return null;
      const texto = String(valor).trim();
      if (!texto) return null;
      return texto.slice(0, regla.max ?? 300);
    }
    default:
      return null;
  }
}

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

    // ---------- set_config: esquema único para TODA la configuración ----------
    // La web manda { campo: valor, ... } y cada campo se valida contra el esquema.
    // Ventaja: agregar un ajuste nuevo = una línea en ESQUEMA_CONFIG; la web
    // descubre los campos desde GET /api/bot/configuracion (nada hardcodeado).
    case 'set_config': {
      const cambios = [];
      const rechazados = [];
      setGuildConfig(guildId, (c) => {
        for (const [campo, valorCrudo] of Object.entries(args)) {
          const regla = ESQUEMA_CONFIG[campo];
          if (!regla) continue; // campo desconocido: ignorado (whitelist estricta)
          const valor = validarContraEsquema(regla, valorCrudo);
          if (valor === null) {
            rechazados.push(campo);
            continue;
          }
          if (regla.rol) {
            if (regla.rol === 'autorol') c.autorole = valor;
            else if (regla.rol === 'mute') c.muteRole = valor;
            else c[`${regla.rol}Role`] = valor;
          } else if (regla.ruta) {
            const partes = regla.ruta.split('.');
            let destino = c;
            while (partes.length > 1) {
              destino = destino[partes[0]] = destino[partes[0]] || {};
              partes.shift();
            }
            destino[partes[0]] = valor;
          } else {
            c[campo] = valor;
          }
          cambios.push(campo);
        }
        // La protección tiene defaults que la web quizá no mandó: completarlos.
        if (c.proteccion && typeof c.proteccion === 'object') {
          c.proteccion = { ...require('../utils/proteccion').POR_DEFECTO, ...c.proteccion };
        }
      });
      if (!cambios.length) return { ok: false, error: 'ningún campo válido' + (rechazados.length ? ` (inválidos: ${rechazados.join(', ')})` : '') };
      return {
        ok: true,
        detalle: `config actualizada: ${cambios.join(', ')}` + (rechazados.length ? ` · ignorados: ${rechazados.join(', ')}` : ''),
      };
    }

    case 'agregar_frase': {
      const texto = String(args.texto || '').trim();
      if (!texto) return { ok: false, error: 'falta texto de la frase' };
      const autor = (String(args.autor || '').trim() || 'Web TriGGer.Arena').slice(0, 100);
      let okFinal = true;
      let detalle = 'frase agregada al rotativo';
      setGuildConfig(guildId, (c) => {
        c.fraseDelDia = c.fraseDelDia || { canalId: null, hora: 12, frases: [], ultima: null };
        c.fraseDelDia.frases = c.fraseDelDia.frases || []; // puede no existir si la web solo seteó canal/hora
        if (c.fraseDelDia.frases.length >= 100) {
          okFinal = false;
          detalle = 'se alcanzó el límite de 100 frases';
          return;
        }
        c.fraseDelDia.frases.push({ texto: texto.slice(0, MAX_TEXTOS), autor });
      });
      return { ok: okFinal, detalle };
    }

    case 'quitar_frase': {
      const indice = enteroEnRango(args.numero, 1, 100);
      if (indice === null) return { ok: false, error: 'numero inválido (empezando en 1)' };
      let quitada = false;
      setGuildConfig(guildId, (c) => {
        const frases = c.fraseDelDia?.frases;
        if (Array.isArray(frases) && frases[indice - 1]) {
          frases.splice(indice - 1, 1);
          quitada = true;
        }
      });
      return quitada ? { ok: true, detalle: `frase #${indice} eliminada` } : { ok: false, error: `no existe la frase #${indice}` };
    }

    case 'agregar_server_cs': {
      const nombre = String(args.nombre || '').trim().slice(0, MAX_TEXTOS);
      const host = String(args.host || '').trim();
      if (!nombre || !host || !/^[\w.-]+$/.test(host)) return { ok: false, error: 'nombre u host inválido' };
      const puerto = enteroEnRango(args.puerto, 1, 65535) ?? 27015;
      const modo = String(args.modo || '').trim().slice(0, 40) || undefined;
      const descripcion = String(args.descripcion || '').trim().slice(0, 300) || undefined;
      const imagen = String(args.imagen || '').trim().slice(0, 300) || undefined;
      let okFinal = true;
      let detalle = `server "${nombre}" agregado`;
      setGuildConfig(guildId, (c) => {
        c.servidores = c.servidores || {};
        c.servidores.lista = c.servidores.lista || [];
        if (c.servidores.lista.length >= 20) {
          okFinal = false;
          detalle = 'se alcanzó el límite de 20 servers';
          return;
        }
        c.servidores.lista.push({ nombre, host, puerto, modo, descripcion, imagen });
      });
      return { ok: okFinal, detalle };
    }

    case 'quitar_server_cs': {
      const indice = enteroEnRango(args.numero, 1, 20);
      if (indice === null) return { ok: false, error: 'numero inválido (empezando en 1)' };
      let quitado = false;
      setGuildConfig(guildId, (c) => {
        const lista = c.servidores?.lista;
        if (Array.isArray(lista) && lista[indice - 1]) {
          lista.splice(indice - 1, 1);
          quitado = true;
          if (!lista.length) delete c.servidores;
        }
      });
      return quitado ? { ok: true, detalle: `server #${indice} eliminado` } : { ok: false, error: `no existe el server #${indice}` };
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
    // ---------- Info real del server de Discord ----------
    const ownerId = g.ownerId ?? null;

    // Canales: la web los necesita para los selectores (id + nombre + tipo).
    // total es la suma; el array va limitado para no inflar la fila de la base.
    const canales = [];
    let totalCanales = 0;
    for (const c of g.channels?.cache?.values() ?? []) {
      totalCanales += 1;
      if (canales.length >= MAX_CANALES_ESTADO) continue;
      canales.push({ id: c.id, nombre: c.name, tipo: c.type });
    }

    // Roles (para set_mute_role y staff desde la web).
    const roles = [];
    for (const r of g.roles?.cache?.values() ?? []) {
      if (roles.length >= MAX_ROLES_ESTADO) break;
      if (r.id === g.id) continue; // @everyone
      roles.push({ id: r.id, nombre: r.name, color: r.hexColor, posicion: r.position });
    }
    roles.sort((a, b) => b.posicion - a.posicion);

    // Emojis y boosts.
    const emojis = [];
    for (const e of g.emojis?.cache?.values() ?? []) {
      if (emojis.length >= 100) break;
      emojis.push({ id: e.id, nombre: e.name, animado: Boolean(e.animated) });
    }

    guilds.push({
      id: g.id,
      nombre: g.name,
      miembros: g.memberCount ?? null,
      icono: g.iconURL?.({ size: 256 }) ?? null,
      descripcion: g.description ?? null,
      dueñoId: ownerId,
      creadoEn: g.createdTimestamp ?? null,
      boosts: g.premiumSubscriptionCount ?? 0,
      nivelBoost: g.premiumTier ?? 0,
      canales,
      totalCanales,
      roles,
      emojis,
      banner: g.bannerURL?.({ size: 1024 }) ?? null,
      splash: g.splashURL?.({ size: 256 }) ?? null,
      verificacion: g.verificationLevel ?? null,
      idCanalSistema: g.systemChannelId ?? null,
      idCanalReglas: g.rulesChannelId ?? null,
      idCanalAFK: g.afkChannelId ?? null,
    });
  }

  // ---------- Estado vivo de los sistemas del bot ----------
  // IA: estado "configurada o no" sin llamadas de red (estadoIA() es async porque
  // lista modelos del proveedor; acá solo interesa si hay clave y qué modelo pide el .env).
  const iaGroq = process.env.GROQ_API_KEY ? process.env.GROQ_MODEL || 'groq (modelo por defecto)' : null;
  const iaGemini = process.env.GEMINI_API_KEY ? process.env.GEMINI_MODEL || 'gemini (modelo por defecto)' : null;
  let statsIa = { groq: 0, gemini: 0, local: 0 };
  try {
    statsIa = require('../utils/ia').getStatsIA();
  } catch {
    /* IA no cargada */
  }

  let dbOk = null;
  try {
    const db = require('./mariadb');
    if (db.configurada && estado.conectado) dbOk = true;
    else if (db.configurada) dbOk = false;
  } catch {
    /* sin db */
  }

  // ---------- Estadísticas por servidor (warns, niveles, afk) ----------
  let estadisticas = {};
  try {
    const niveles = require('../niveles');
    const warns = require('../warns');
    const afkMod = require('../commands/afk');
    const interacciones = require('../utils/interacciones');
    const registro = require('../utils/proteccion');
    estadisticas = Object.fromEntries(
      guilds.map((g) => {
        const id = g.id;
        const datos = {}; // datos del almacén de niveles: { userId: { xp, ... } }
        try {
          const crudos = niveles.leer(id) || {};
          const usuarios = Object.keys(crudos).length;
          let sumaXp = 0;
          let sumaMensajes = 0;
          for (const info of Object.values(crudos)) {
            sumaXp += Number(info?.xp) || 0;
            sumaMensajes += Number(info?.mensajes) || 0;
          }
          datos.niveles = {
            usuarios,
            xpTotal: sumaXp,
            mensajesConXp: sumaMensajes,
            top: niveles.ranking(id, 10), // [{ userId, xp, nivel, mensajes }]
          };
        } catch {
          datos.niveles = { usuarios: 0, xpTotal: 0, mensajesConXp: 0, top: [] };
        }
        try {
          const w = warns.leer(id) || {};
          const porUsuario = Object.entries(w).map(([usuarioId, lista]) => ({ usuarioId, cantidad: Array.isArray(lista) ? lista.length : 0 }));
          datos.warns = { usuarios: porUsuario.length, total: porUsuario.reduce((s, u) => s + u.cantidad, 0), porUsuario };
        } catch {
          datos.warns = { usuarios: 0, total: 0, porUsuario: [] };
        }
        try {
          const a = afkMod.leer(id) || {};
          datos.afk = { cantidad: Object.keys(a).length, usuarios: Object.keys(a) };
        } catch {
          datos.afk = { cantidad: 0, usuarios: [] };
        }
        try {
          const it = interacciones.leer(id) || {};
          const porAccion = {};
          let totalInteracciones = 0;
          for (const [accion, mapa] of Object.entries(it)) {
            const suma = Object.values(mapa).reduce((s, n) => s + (Number(n) || 0), 0);
            porAccion[accion] = suma;
            totalInteracciones += suma;
          }
          datos.interacciones = { total: totalInteracciones, porAccion };
        } catch {
          datos.interacciones = { total: 0, porAccion: {} };
        }
        // Últimos eventos de moderación que la web puede mostrar: el puente registra
        // el último aviso de spam/raid visto por el bot (memoria, no disco).
        datos.antiSpamConfig = registro.configDe(id);
        return [id, datos];
      })
    );
  } catch {
    estadisticas = {};
  }

  return {
    online: Boolean(client.isReady?.()),
    pingMs,
    servidores: guilds.length,
    guilds,
    estadisticas,
    comandos: client.commands?.size ?? 0,
    uptimeSeg: Math.floor(process.uptime()),
    memoriaMb: Math.round(process.memoryUsage().rss / 1048576),
    versionNodo: process.version,
    bot: {
      id: client.user?.id ?? null,
      nombre: client.user?.username ?? null,
      discriminador: client.user?.discriminator ?? null,
      avatar: client.user?.displayAvatarURL?.({ size: 256 }) ?? null,
      estado: client.user?.presence?.status ?? null,
    },
    ia: { groq: iaGroq, gemini: iaGemini, stats: statsIa },
    baseDatos: { ok: dbOk, subidasOk: estado.subidasOk ?? 0, ultimoError: estado.ultimoError ?? null },
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
