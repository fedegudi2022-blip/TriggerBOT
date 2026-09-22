const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../store');
const { construirGuia, construirGuiaStaff } = require('../utils/guia');
const { errorEmbed } = require('../utils/replies');

const LEVELS = ['admin', 'mod', 'helper'];

// Mismo criterio de staff que el resto del bot: ManageGuild o rol admin/mod/helper
// configurado en /config (el bot ignora la jerarquía de roles de Discord a propósito).
function esStaff(interaction) {
  if (interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const config = getGuildConfig(interaction.guildId);
  return LEVELS.some((nivel) => interaction.member.roles.cache.has(config[`${nivel}Role`]));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Muestra la guía de TriggerBOT y sus comandos')
    .addSubcommand((sub) =>
      sub
        .setName('user')
        .setDescription('Guía de comandos para usuarios: qué podés usar y cómo funciona cada cosa')
    )
    .addSubcommand((sub) =>
      sub
        .setName('staff')
        .setDescription('Guía completa de staff: moderación, configuración y comandos internos')
    )
    // Sin setDefaultMemberPermissions en 'staff': el staff lo define el bot con
    // ManageGuild O los roles admin/mod/helper de /config (misma política que /config).
    // Discord ocultaría el comando a un helper configurado solo por rol, así que la
    // política interna de esStaff() es la única fuente de verdad para ambas opciones.
  ,

  async execute(interaction, client) {
    if (interaction.options.getSubcommand() === 'staff') {
      if (!esStaff(interaction)) {
        return interaction.reply({
          embeds: [errorEmbed('Esta parte de la guía es solo para staff.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      // La guía de staff es efímera: nadie más la ve, ni en canales públicos.
      return interaction.reply({ embeds: [construirGuiaStaff(client)], flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ embeds: [construirGuia(client)] });
  },
};
