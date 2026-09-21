const { getGuildConfig, setGuildConfig } = require('../store');

// Plantillas de razones de sanción por servidor: { [nombre]: razon }.
// El staff las carga una vez y después el autocompletado de Discord las
// sugiere directamente en /warn, /ban, /kick, /timeout, /softban y /mute.

function listar(guildId) {
  return getGuildConfig(guildId).plantillas ?? {};
}

function agregar(guildId, nombre, razon) {
  setGuildConfig(guildId, (c) => {
    c.plantillas = c.plantillas || {};
    c.plantillas[nombre] = razon;
  });
}

function quitar(guildId, nombre) {
  const existe = nombre in listar(guildId);
  if (existe) {
    setGuildConfig(guildId, (c) => {
      delete c.plantillas[nombre];
    });
  }
  return existe;
}

// Autocompletado: sugiere las plantillas que matcheen lo tipeado.
// El value es la razón completa, así al elegir la plantilla se llena el campo.
async function autocompletar(interaction) {
  const tipeado = String(interaction.options.getFocused() ?? '').toLowerCase();
  const opciones = Object.entries(listar(interaction.guildId))
    .filter(([nombre]) => nombre.toLowerCase().includes(tipeado))
    .slice(0, 25)
    .map(([nombre, razon]) => ({ name: `${nombre} — ${razon}`.slice(0, 100), value: razon }));
  await interaction.respond(opciones);
}

module.exports = { listar, agregar, quitar, autocompletar };
