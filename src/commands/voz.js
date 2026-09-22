// /voz — configura el sistema de canales de voz temporales (Join-to-Create).
// El staff crea el canal hub con un clic y los usuarios entran para tener su
// canal propio con controles; se borra solo cuando queda vacío.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { setGuildConfig } = require('../store');
const { successEmbed, errorEmbed, brandEmbed } = require('../utils/replies');
const voz = require('../utils/voz');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('voz')
    .setDescription('Canales de voz temporales: cada usuario crea el suyo al entrar (solo staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sc) => sc.setName('activar').setDescription('Crea el canal «➕ Crear canal» y activa el sistema'))
    .addSubcommand((sc) =>
      sc
        .setName('hub')
        .setDescription('Usa un canal de voz existente como canal de creación')
        .addChannelOption((o) => o.setName('canal').setDescription('Canal de voz que actúa como hub').setRequired(true))
    )
    .addSubcommand((sc) => sc.setName('desactivar').setDescription('Apaga el sistema y borra el canal de creación'))
    .addSubcommand((sc) =>
      sc
        .setName('formato')
        .setDescription('Cambia el nombre de los canales temporales')
        .addStringOption((o) =>
          o.setName('plantilla').setDescription('Usá {usuario} donde va el nombre. Ej: «🔊 Canal de {usuario}»').setMaxLength(90)
        )
    )
    .addSubcommand((sc) => sc.setName('estado').setDescription('Muestra la configuración y los canales temporales activos')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'activar') {
      const config = voz.vozDe?.(interaction.guildId);
      if (config?.hubId && interaction.guild.channels.cache.get(config.hubId)) {
        return interaction.reply({
          embeds: [errorEmbed('El sistema ya está activo. Usá `/voz desactivar` primero si querés rehacer el hub.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const categoria = interaction.channel?.parentId ?? undefined;
      const hub = await interaction.guild.channels.create({
        name: voz.NOMBRE_HUB,
        type: ChannelType.GuildVoice,
        parent: categoria,
        permissionOverwrites: [],
      });
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        c.voz.hubId = hub.id;
      });
      return interaction.editReply({
        embeds: [
          successEmbed(
            `Canal **${voz.NOMBRE_HUB}** creado.\nCuando alguien entre, se le crea **su propio canal de voz** con panel de controles ` +
              '(renombrar, límite, cerrar, expulsar, transferir). Se borra solo cuando queda vacío.'
          ),
        ],
      });
    }

    if (sub === 'hub') {
      const canal = interaction.options.getChannel('canal', true);
      if (canal.type !== ChannelType.GuildVoice) {
        return interaction.reply({ embeds: [errorEmbed('El hub tiene que ser un canal **de voz**.')], flags: MessageFlags.Ephemeral });
      }
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        c.voz.hubId = canal.id;
      });
      return interaction.reply({
        embeds: [successEmbed(`**${canal.name}** ahora es el canal de creación: al entrar, cada usuario recibe su canal propio.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'desactivar') {
      const config = voz.vozDe(interaction.guildId);
      if (!config.hubId) {
        return interaction.reply({ embeds: [errorEmbed('El sistema no está activo.')], flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const hub = interaction.guild.channels.cache.get(config.hubId);
      if (hub) await hub.delete('Sistema de canales de voz desactivado').catch(() => {});
      setGuildConfig(interaction.guildId, (c) => {
        if (c.voz) delete c.voz.hubId;
      });
      return interaction.editReply({ embeds: [successEmbed('Sistema desactivado. Los canales temporales ya creados se borran solos al vaciarse.')] });
    }

    if (sub === 'formato') {
      const plantilla = interaction.options.getString('plantilla')?.trim();
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        if (plantilla) c.voz.formato = plantilla;
        else delete c.voz.formato;
      });
      return interaction.reply({
        embeds: [
          successEmbed(
            plantilla
              ? `Formato actualizado: **${voz.nombreCanal(plantilla, 'Federico')}**`
              : 'Volvimos al formato por defecto: **🔊 Canal de {usuario}**.'
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'estado') {
      const config = voz.vozDe(interaction.guildId);
      const hub = config.hubId ? interaction.guild.channels.cache.get(config.hubId) : null;
      const temporales = Object.entries(voz.temporalesDe(interaction.guildId));
      const lista = temporales
        .map(([canalId, duenoId]) => {
          const canal = interaction.guild.channels.cache.get(canalId);
          return canal ? `• **${canal.name}** — dueño: <@${duenoId}> (${canal.members.size} adentro)` : null;
        })
        .filter(Boolean)
        .join('\n');

      const embed = brandEmbed({
        color: 0x5865f2,
        title: '🎧 Canales de voz temporales',
        description:
          `**Estado:** ${hub ? '🟢 Activo' : '🔴 Inactivo'}\n` +
          `**Canal de creación:** ${hub ? hub.name : 'sin configurar'}\n` +
          `**Formato:** ${config.formato || voz.PLANTILLA_NOMBRE}\n\n` +
          `**Canales activos (${temporales.length}):**\n${lista || '*ninguno en este momento*'}`,
      });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
};
