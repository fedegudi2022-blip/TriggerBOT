// Roles por nivel: el staff configura en el panel de /config qué rol se otorga
// automáticamente al alcanzar cada nivel, y el bot lo asigna al subir.
// Persiste en la config del servidor (data/config.json + MariaDB).

const { getGuildConfig, setGuildConfig } = require('../store');

// Umbral por defecto (el staff puede cambiarlo por servidor).
const UMBRALES = [5, 10, 20, 30];

// ---------- Config por servidor ----------
// config.rolesNivel = { "5": roleId, "10": roleId, ... }
function rolesConfigurados(guildId) {
  const config = getGuildConfig(guildId);
  return config.rolesNivel ?? {};
}

function definirRol(guildId, nivel, roleId) {
  setGuildConfig(guildId, (c) => {
    c.rolesNivel = c.rolesNivel || {};
    if (roleId === null) delete c.rolesNivel[String(nivel)];
    else c.rolesNivel[String(nivel)] = roleId;
  });
}

// ---------- Asignación automática ----------
// Al subir de nivel, otorga el rol del mayor umbral alcanzado (si no lo tiene ya).
// No quita roles de niveles anteriores: son acumulativos (progresión, no jerarquía).
// Devuelve SOLO los roles que se otorgaron en esta llamada ({ id, nombre }) para que
// el anuncio de la subida pueda nombrarlos: si la asignación falla (permisos o
// jerarquía) el rol no entra en la lista, así el mensaje no promete algo que no pasó.
async function asignarRolesNivel(member, nivel) {
  if (!member || !member.guild) return [];
  const mapa = rolesConfigurados(member.guild.id);
  const umbrales = Object.keys(mapa)
    .map(Number)
    .filter((n) => n <= nivel)
    .sort((a, b) => b - a);

  const otorgados = [];
  for (const umbral of umbrales) {
    const roleId = mapa[String(umbral)];
    if (!roleId || member.roles.cache.has(roleId)) continue;
    const rol = member.guild.roles.cache.get(roleId);
    if (!rol || rol.managed || !member.guild.members.me.permissions.has('ManageRoles')) continue;
    if (rol.position >= member.guild.members.me.roles.highest.position) continue; // jerarquía
    try {
      await member.roles.add([roleId], 'Recompensa por nivel alcanzado (TriggerBOT)');
      otorgados.push({ id: roleId, nombre: rol.name });
    } catch {
      // Sin permiso real o problema puntual de Discord: se ignora, como antes.
    }
  }
  return otorgados;
}

// Sincroniza todos los roles que corresponden al nivel actual (usado por /rolnivel).
async function sincronizarRoles(member) {
  const nivel = require('../niveles').datosDe(member.guild.id, member.id).nivel ?? 0;
  await asignarRolesNivel(member, Math.max(nivel, 0));
  return rolesConfigurados(member.guild.id);
}

module.exports = { UMBRALES, rolesConfigurados, definirRol, asignarRolesNivel, sincronizarRoles };
