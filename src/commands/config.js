const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { panelCompleto, manejarComponente, nivelStaff } = require('../utils/configPanel');
const { errorEmbed } = require('../utils/replies');

const LEVELS = ['admin', 'mod', 'helper'];

// Devuelve true si el usuario puede ABRIR el panel: cualquier nivel de staff
// (admin, mod o helper) o ManageGuild. Las secciones sensibles (roles de staff,
// escalada y anti-spam/raid) se revalidan aparte y son solo para admin
// (ver utils/configPanel.js → SECCIONES_SENSIBLES).
function isMod(interaction) {
  return nivelStaff(interaction) !== null;
}

module.exports = {
  LEVELS,
  isMod,

  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Abre el panel de configuración del bot para este servidor (solo staff)'),
  // Sin setDefaultMemberPermissions: la política interna (nivelStaff: ManageGuild,
  // dueño o roles admin/mod/helper configurados) es la única fuente de verdad. Si
  // declarara ManageGuild acá, Discord le ocultaría el comando a un moderador
  // configurado por rol aunque nivelStaff() lo aceptaría.

  async execute(interaction) {
    if (!isMod(interaction)) {
      return interaction.reply({
        embeds: [errorEmbed('No tenés permiso para usar /config.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    // El panel es efímero: solo lo ve quien lo abrió, sin ensuciar el canal.
    await interaction.reply({ ...panelCompleto(interaction), flags: MessageFlags.Ephemeral });
  },
};

// Los botones/selectores/modales del panel pasan por el mismo chequeo de nivel.
void manejarComponente;
