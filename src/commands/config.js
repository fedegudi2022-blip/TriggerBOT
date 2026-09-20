const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const LEVELS = ['admin', 'mod', 'helper'];
const LEVEL_LABELS = { admin: 'Administrador', mod: 'Moderador', helper: 'Helper' };

function isMod(interaction) {
  const config = require('../store').getGuildConfig(interaction.guildId);
  if (interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return LEVELS.some((level) => interaction.member.roles.cache.has(config[`${level}Role`]));
}

module.exports = {
  LEVELS,
  LEVEL_LABELS,
  isMod,

  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configura el bot para este servidor (solo administradores)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('ver')
        .setDescription('Muestra la configuración actual del bot en este servidor')
    )
    .addSubcommand((sc) =>
      sc
        .setName('welcome')
        .setDescription('Configura la bienvenida para nuevos miembros')
        .addChannelOption((o) =>
          o
            .setName('canal')
            .setDescription('Canal donde se anuncian los nuevos miembros (vacío = no cambiar)')
            .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption((o) =>
          o
            .setName('mensaje')
            .setDescription('Texto de bienvenida. Variables: {usuario} {servidor} {miembros} (vacío = no cambiar)')
            .setMaxLength(1000)
        )
        .addRoleOption((o) =>
          o
            .setName('autorol')
            .setDescription('Rol que se asigna automáticamente al entrar (vacío = no cambiar)')
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('modlog')
        .setDescription('Canal donde se registran kick/ban/timeout/clear')
        .addChannelOption((o) =>
          o
            .setName('canal')
            .setDescription('Canal de registro de moderación')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('staff')
        .setDescription('Define qué roles son staff del bot (admin > mod > helper)')
        .addRoleOption((o) => o.setName('admin').setDescription('Rol administrador del bot'))
        .addRoleOption((o) => o.setName('mod').setDescription('Rol moderador del bot'))
        .addRoleOption((o) => o.setName('helper').setDescription('Rol helper del bot'))
    )
    .addSubcommand((sc) =>
      sc
        .setName('desactivar')
        .setDescription('Apaga funciones del bot en este servidor')
        .addStringOption((o) =>
          o
            .setName('funcion')
            .setDescription('Función a apagar')
            .setRequired(true)
            .addChoices(
              { name: 'Bienvenida', value: 'welcome' },
              { name: 'Autorol', value: 'autorole' },
              { name: 'Registro de moderación (mod-log)', value: 'modlog' }
            )
        )
    ),

  async execute(interaction) {
    if (!isMod(interaction)) {
      return interaction.reply({ content: '❌ No tenés permiso para usar /config.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const store = require('../store');
    const config = store.getGuildConfig(interaction.guildId);

    if (sub === 'ver') {
      const estado = (value, texto) => (value ? `✅ ${texto}` : '❌ Desactivado');
      const welcomeChannel = config.welcome?.channelId ? `<#${config.welcome.channelId}>` : null;
      const autorole = config.autorole ? `<@&${config.autorole}>` : null;
      const modlog = config.modlog ? `<#${config.modlog}>` : null;
      const staffLines = LEVELS.map(
        (level) => `• ${LEVEL_LABELS[level]}: ${config[`${level}Role`] ? `<@&${config[`${level}Role`]}>` : '—'}`
      ).join('\n');

      const embed = new EmbedBuilder()
        .setTitle('⚙️ Configuración de TriggerBOT')
        .setColor(0x5865f2)
        .addFields(
          { name: 'Bienvenida', value: estado(welcomeChannel, welcomeChannel), inline: true },
          { name: 'Autorol', value: estado(autorole, autorole), inline: true },
          { name: 'Mod-log', value: estado(modlog, modlog), inline: true },
          { name: 'Mensaje de bienvenida', value: config.welcome?.message || '*(por defecto)*', inline: false },
          { name: 'Staff del bot', value: staffLines, inline: false }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'welcome') {
      const channelId = interaction.options.getChannel('canal')?.id ?? null;
      const message = interaction.options.getString('mensaje');
      const role = interaction.options.getRole('autorol');

      if (channelId === null && message === null && role === null) {
        return interaction.reply({
          content: '⚠️ No pasaste ninguna opción. Pasá al menos una para cambiar algo.',
          ephemeral: true,
        });
      }

      store.setGuildConfig(interaction.guildId, (c) => {
        c.welcome = c.welcome || {};
        if (channelId !== null) c.welcome.channelId = channelId;
        if (message !== null) c.welcome.message = message;
        if (role) c.autorole = role.id;
      });

      const parts = [];
      if (channelId !== null) parts.push(`canal: <#${channelId}>`);
      if (message !== null) parts.push('mensaje actualizado');
      if (role) parts.push(`autorol: <@&${role.id}>`);
      return interaction.reply({ content: `✅ Bienvenida actualizada (${parts.join(', ')}).`, ephemeral: true });
    }

    if (sub === 'modlog') {
      const channel = interaction.options.getChannel('canal');
      store.setGuildConfig(interaction.guildId, (c) => {
        c.modlog = channel.id;
      });
      return interaction.reply({ content: `✅ Mod-log configurado en <#${channel.id}>.`, ephemeral: true });
    }

    if (sub === 'staff') {
      const admin = interaction.options.getRole('admin');
      const mod = interaction.options.getRole('mod');
      const helper = interaction.options.getRole('helper');

      if (!admin && !mod && !helper) {
        return interaction.reply({
          content: '⚠️ Pasá al menos un rol (admin, mod o helper).',
          ephemeral: true,
        });
      }

      store.setGuildConfig(interaction.guildId, (c) => {
        if (admin) c.adminRole = admin.id;
        if (mod) c.modRole = mod.id;
        if (helper) c.helperRole = helper.id;
      });
      return interaction.reply({ content: '✅ Roles de staff actualizados.', ephemeral: true });
    }

    if (sub === 'desactivar') {
      const feature = interaction.options.getString('funcion');
      store.setGuildConfig(interaction.guildId, (c) => {
        if (feature === 'welcome') delete c.welcome;
        if (feature === 'autorole') delete c.autorole;
        if (feature === 'modlog') delete c.modlog;
      });
      return interaction.reply({ content: `✅ Función **${feature}** desactivada.`, ephemeral: true });
    }
  },
};
