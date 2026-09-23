const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { UMBRALES, rolesConfigurados, definirRol } = require('../utils/rolesNivel');
const { infoEmbed, warnEmbed, errorEmbed, successEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rolnivel')
    .setDescription('Configura roles que se otorgan automáticamente al alcanzar un nivel (staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('definir')
        .setDescription('Asigna un rol de recompensa a un nivel')
        .addIntegerOption((o) => o.setName('nivel').setDescription('Nivel requerido (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
        .addRoleOption((o) => o.setName('rol').setDescription('Rol que se otorga al llegar a ese nivel').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('quitar')
        .setDescription('Elimina la recompensa de un nivel')
        .addIntegerOption((o) => o.setName('nivel').setDescription('Nivel a limpiar (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Muestra los roles por nivel configurados')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'definir') {
      const nivel = interaction.options.getInteger('nivel');
      const rol = interaction.options.getRole('rol');

      if (rol.managed) {
        return interaction.reply({
          embeds: [
            errorEmbed('Es un rol integrado (de un bot o de una integración): Discord no lo deja asignar a mano.', 'No se puede usar ese rol'),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
      const yo = interaction.guild.members.me;
      if (rol.position >= yo.roles.highest.position) {
        return interaction.reply({
          embeds: [errorEmbed('Subí mi rol en la configuración del servidor para que pueda otorgarlo.', 'Ese rol está por encima mío')],
          flags: MessageFlags.Ephemeral,
        });
      }

      definirRol(guildId, nivel, rol.id);
      return interaction.reply({
        embeds: [successEmbed(`Al llegar al **nivel ${nivel}**, los miembros reciben automáticamente ${rol}.`, 'Recompensa configurada')],
      });
    }

    if (sub === 'quitar') {
      const nivel = interaction.options.getInteger('nivel');
      const antes = rolesConfigurados(guildId);
      if (!antes[String(nivel)]) {
        return interaction.reply({
          embeds: [errorEmbed(`El nivel ${nivel} no tiene rol asignado.`, 'Nada que quitar')],
          flags: MessageFlags.Ephemeral,
        });
      }
      definirRol(guildId, nivel, null);
      return interaction.reply({ embeds: [successEmbed(`Se quitó la recompensa del nivel ${nivel}.`, 'Recompensa eliminada')] });
    }

    // lista
    const mapa = rolesConfigurados(guildId);
    const entradas = Object.entries(mapa).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (!entradas.length) {
      return interaction.reply({
        embeds: [
          warnEmbed(`No hay recompensas configuradas. Usá \`/rolnivel definir\` con niveles sugeridos: ${UMBRALES.join(', ')}.`, 'Roles por nivel'),
        ],
      });
    }
    const lineas = entradas.map(([nivel, roleId]) => {
      const rol = interaction.guild.roles.cache.get(roleId);
      return `Nivel **${nivel}** → ${rol ? `${rol}` : '`rol eliminado`'}`;
    });
    return interaction.reply({ embeds: [infoEmbed(lineas.join('\n'), 'Roles por nivel')] });
  },
};
