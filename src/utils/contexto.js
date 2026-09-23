// Contexto en vivo para el chat con IA (utils/ia.js).
//
// Por qué existe: el prompt de la IA era 100% estático. Sabía "moderar" en abstracto
// pero no sabía nada del servidor real, así que cualquier pregunta con datos
// (tu nivel, cuántos jugadores hay, qué comandos existen, si hay tickets) se
// respondía a ciegas o inventada. Acá juntamos, en cada mensaje, un bloque corto de
// datos REALES: quién pregunta y su ficha, el estado de los servidores CS, la config
// relevante y el catálogo de comandos generado desde client.commands (fin de la
// lista hardcodeada que se desincronizaba).
//
// Todo es de solo lectura y barato (memoria y caches locales): no se consulta a
// Discord ni se escriben datos desde acá. Si algo falla, el contexto se omite y la
// charla sigue funcionando.

const { PermissionFlagsBits } = require('discord.js');
const { getGuildConfig } = require('../store');
const { miles } = require('./replies');

const FRESCURA_CS_MS = 5 * 60 * 1000; // un dato de servidor CS más viejo que esto se aclara

// Comandos que necesitan permisos: se marcan para que la IA avise que son de staff.
const COMANDOS_STAFF = new Set([
  'ban', 'unban', 'softban', 'kick', 'warn', 'warnings', 'quitarnota', 'timeout', 'mute', 'unmute',
  'clear', 'lockdown', 'slowmode', 'config', 'rolnivel', 'voz', 'ticket', 'embed', 'plantillas', 'frases',
]);

// ---------- Catálogo real de comandos (fuente: client.commands) ----------
function catalogoComandos(client, { detallado = true } = {}) {
  const comandos = client?.commands;
  if (!comandos?.size) return '';

  const entradas = [...comandos.values()]
    .map((c) => ({ nombre: c?.data?.name, descripcion: c?.data?.description ?? '' }))
    .filter((c) => c.nombre)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  const lista = entradas.map((c) => {
    const staff = COMANDOS_STAFF.has(c.nombre) ? ' (solo staff)' : '';
    if (!detallado) return `/${c.nombre}${staff}`;
    const desc = c.descripcion.length > 70 ? `${c.descripcion.slice(0, 70)}…` : c.descripcion;
    return `/${c.nombre}${staff}${desc ? `: ${desc}` : ''}`;
  });

  return `Comandos (${entradas.length}, la lista real): ${lista.join(' | ')}`;
}

// ---------- Ficha de quien pregunta ----------
function esStaff(guild, member) {
  if (!member) return false;
  if (guild?.ownerId === member.id) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.ModerateMembers)) return true;
  const config = getGuildConfig(guild?.id);
  return ['admin', 'mod', 'helper'].some((nivel) => member.roles?.cache?.has?.(config[`${nivel}Role`]));
}

// Nivel, XP, puesto, racha, logros y advertencias del autor del mensaje.
function fichaUsuario(guild, member) {
  if (!guild?.id || !member?.id) return '';
  try {
    const { datosDe, posicion, totalUsuarios, rangoDe } = require('../niveles');
    const { getWarns } = require('../warns');

    const datos = datosDe(guild.id, member.id);
    const puesto = posicion(guild.id, member.id);
    const total = totalUsuarios(guild.id);
    const partes = [
      `nivel ${datos.nivel || 0} (${rangoDe(datos.nivel || 0).nombre})`,
      `${miles(datos.xp || 0)} XP`,
    ];
    if (puesto > 0) partes.push(`puesto ${puesto} de ${total} en el ranking`);
    if (datos.racha) partes.push(`racha de ${datos.racha} día(s)`);
    if (datos.mensajes) partes.push(`${miles(datos.mensajes)} mensajes`);
    partes.push(`${datos.logros?.length || 0} logro(s) desbloqueado(s)`);

    const warns = getWarns(guild.id, member.id)?.length || 0;
    if (warns) partes.push(`${warns} advertencia(s)`);

    let extra = '';
    const silenciadoHasta = member.communicationDisabledUntilTimestamp;
    if (silenciadoHasta && new Date(silenciadoHasta).getTime() > Date.now()) {
      extra += ` Está silenciado con timeout hasta ${new Date(silenciadoHasta).toLocaleString('es-AR')}.`;
    }
    if (esStaff(guild, member)) {
      extra += guild.ownerId === member.id ? ' Es el DUEÑO del servidor.' : ' Es del staff.';
    }

    return `Quien escribe: ${member.displayName || member.user?.username || 'un miembro'} — ${partes.join(', ')}.${extra}`;
  } catch {
    return '';
  }
}

// ---------- Estado de los servidores CS 1.6 (desde la cache del monitoreo) ----------
// No consulta ni escribe la cache de monitoreo: si el dato está viejo, lo dice y
// sugiere /servidores, en vez de mentir con información de hace media hora.
function estadoServidores(guild) {
  const lista = getGuildConfig(guild?.id).servidores?.lista;
  if (!lista?.length) return '';

  try {
    const monitoreo = require('./monitoreo');
    const ahora = Date.now();
    const partes = lista.slice(0, 6).map((server) => {
      const [host, puerto] = monitoreo.parsearDestino(server);
      const s = monitoreo.cache.get(`${host}:${puerto}`);
      if (!s) return `${server.nombre}: sin datos todavía`;
      const antiguedad = ahora - (s.cuando || 0);
      const viejo = antiguedad > FRESCURA_CS_MS;
      const cuando = viejo ? ` (dato de hace ${Math.round(antiguedad / 60000)} min)` : '';
      if (!s.ok) return `${server.nombre}: caído${cuando}`;
      return `${server.nombre}: ${s.datos.jugadores}/${s.datos.maximo} jugadores en ${s.datos.mapa}${cuando}`;
    });
    return `Servidores CS 1.6: ${partes.join(' · ')} (detalle en vivo en /servidores)`;
  } catch {
    return '';
  }
}

// ---------- Config del servidor que puede interesarle a un usuario ----------
function estadoConfig(guild) {
  const config = getGuildConfig(guild?.id);
  const partes = [];
  if (config.tickets?.categoriaId) partes.push('el soporte por tickets está activo (botón 📨)');
  if (config.voz?.hubId) partes.push('los canales de voz temporales están activos');
  if (config.proteccion?.activado) partes.push('el anti-spam/anti-raid automático está prendido');
  if (config.welcome?.channelId) partes.push('hay mensaje de bienvenida para los nuevos');
  return partes.length ? `Sistema del server: ${partes.join(', ')}.` : '';
}

// ---------- Armado final del bloque de contexto ----------
// `detallado: false` (charla) manda solo el nombre de los comandos: ahorra ~1000
// caracteres de prompt por mensaje, que en los límites de tokens por minuto del
// nivel gratuito se notan. Las descripciones van cuando alguien pregunta de verdad.
function construirContextoVivo({ client, guild, member, canal, detallado = true } = {}) {
  const lineas = [];

  if (guild) {
    const miembros = guild.memberCount ?? guild.members?.cache?.size ?? 0;
    lineas.push(`Servidor: ${guild.name} — ${miles(miembros)} miembros.`);
  }
  const ficha = fichaUsuario(guild, member);
  if (ficha) lineas.push(ficha);
  if (canal) lineas.push(`Canal: #${canal.name || canal}.`);

  const servidores = estadoServidores(guild);
  if (servidores) lineas.push(servidores);
  const config = estadoConfig(guild);
  if (config) lineas.push(config);

  const catalogo = catalogoComandos(client, { detallado });
  if (catalogo) lineas.push(catalogo);

  return lineas.join('\n');
}

module.exports = {
  construirContextoVivo,
  catalogoComandos,
  fichaUsuario,
  estadoServidores,
  estadoConfig,
  esStaff,
  COMANDOS_STAFF,
};
