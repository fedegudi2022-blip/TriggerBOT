const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { successEmbed } = require('../utils/replies');

// Estado AFK por servidor: { [guildId]: { [userId]: { motivo, desde } } }
// Guardado en disco para sobrevivir reinicios.
const fs = require('node:fs');
const path = require('node:path');
const { marcarSucio } = require('../db/sync');

// Directorio de datos configurable (TRIGGER_DATA_DIR) para tests y despliegues.
const DATA_DIR = process.env.TRIGGER_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'afk.json');

let cache = {};

// Marca del último cambio local POR servidor (comparación guild-por-guild con la nube).
const marcasCambio = new Map();
function tocarMarca(guildId) {
  const previa = marcasCambio.get(guildId) ?? 0;
  marcasCambio.set(guildId, Math.max(previa, Date.now()));
}

try {
  if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (error) {
  console.error('[TriggerBOT] No se pudo leer data/afk.json:', error.message);
  cache = {};
}

// Al arrancar: si el archivo existía, cada guild hereda su mtime como marca base.
(function inicializarMarcas() {
  const mtime = fs.existsSync(FILE) ? fs.statSync(FILE).mtimeMs : 0;
  for (const guildId of Object.keys(cache)) marcasCambio.set(guildId, mtime);
})();

function guardar() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
}

function setAFK(guildId, userId, motivo) {
  cache[guildId] = cache[guildId] || {};
  cache[guildId][userId] = { motivo, desde: Date.now() };
  guardar();
  tocarMarca(guildId);
  marcarSucio(guildId, 'afk', () => cache[guildId] ?? {});
}

function getAFK(guildId, userId) {
  return cache[guildId]?.[userId] ?? null;
}

function quitarAFK(guildId, userId) {
  if (cache[guildId]?.[userId]) {
    delete cache[guildId][userId];
    guardar();
    tocarMarca(guildId);
    marcarSucio(guildId, 'afk', () => cache[guildId] ?? {});
  }
}

// Volcado forzado (el AFK ya guarda síncrono; existe por simetría con el apagado).
function volcar() {
  /* el AFK se escribe siempre al momento */ }

// ---------- Integración con la base de datos (respaldo en MariaDB) ----------
// Marca del último cambio real por servidor (la usa db/sync.js al restaurar).
function marcasPorGuild() {
  return Object.fromEntries(marcasCambio);
}

function leerGuilds() {
  const mtime = fs.existsSync(FILE) ? fs.statSync(FILE).mtimeMs : 0;
  const out = {};
  for (const guildId of Object.keys(cache)) out[guildId] = mtime;
  return out;
}

function leer(guildId) {
  return cache[guildId] ?? {};
}

function escribir(guildId, datos) {
  cache[guildId] = datos ?? {};
  guardar();
  tocarMarca(guildId);
}

module.exports = {
  setAFK,
  getAFK,
  quitarAFK,
  leerGuilds,
  marcasPorGuild,
  leer,
  escribir,
  volcar,

  data: new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Te marca como ausente (el bot avisa cuando te mencionan)')
    .addStringOption((o) => o.setName('motivo').setDescription('Por qué estás AFK (opcional)').setMaxLength(200)),

  async execute(interaction) {
    const motivo = interaction.options.getString('motivo') || 'sin motivo especificado';
    setAFK(interaction.guildId, interaction.user.id, motivo);
    return interaction.reply({
      embeds: [successEmbed(`Quedaste marcado como **AFK**: ${motivo}.\nCuando volvas a hablar, se te saca automáticamente.`, 'Modo ausente')],
      flags: MessageFlags.Ephemeral,
    });
  },
};
