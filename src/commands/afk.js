const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { successEmbed } = require('../utils/replies');

// Estado AFK por servidor: { [guildId]: { [userId]: { motivo, desde } } }
// Guardado en disco para sobrevivir reinicios.
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'afk.json');

let cache = {};

try {
  if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (error) {
  console.error('[TriggerBOT] No se pudo leer data/afk.json:', error.message);
  cache = {};
}

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
}

function getAFK(guildId, userId) {
  return cache[guildId]?.[userId] ?? null;
}

function quitarAFK(guildId, userId) {
  if (cache[guildId]?.[userId]) {
    delete cache[guildId][userId];
    guardar();
  }
}

module.exports = {
  setAFK,
  getAFK,
  quitarAFK,

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
