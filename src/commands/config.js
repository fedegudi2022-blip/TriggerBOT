const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../store');
const { panelCompleto, manejarComponente } = require('../utils/configPanel');
const { errorEmbed } = require('../utils/replies');

const LEVELS = ['admin', 'mod', 'helper'];

// Devuelve true si el usuario puede usar /config y el panel.
function isMod(interaction) {
  if (interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const config = getGuildConfig(interaction.guildId);
  return LEVELS.some((level) => interaction.member.roles.cache.has(config[`${level}Role`]));
}

module.exports = {
  LEVELS,
  isMod,

  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Abre el panel de configuración del bot para este servidor (solo staff)')
  ,
  // Sin setDefaultMemberPermissions: la política interna (isMod: ManageGuild O roles
  // admin/mod/helper configurados) es la única fuente de verdad. Si declaráramos
  // ManageGuild acá, Discord le ocultaría el comando a un moderador configurado
  // por rol, aunque isMod() lo aceptaría. El chequeo efímero de execute() basta.

  async execute(interaction) {
    if (!isMod(interaction)) {
      return interaction.reply({
        embeds: [errorEmbed('No tenés permiso para usar /config.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    // El panel es efímero: solo lo ve quien lo abrió, sin ensuciar el canal.
    await interaction.reply({ ...panelCompleto(interaction.guild), flags: MessageFlags.Ephemeral });
  },
};

// Los botones/selectores/modales del panel pasan por el mismo chequeo de staff.
void manejarComponente;
