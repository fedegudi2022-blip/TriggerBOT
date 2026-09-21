const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} = require('discord.js');
const { successEmbed, errorEmbed, warnEmbed } = require('../utils/replies');

const LEVELS = ['admin', 'mod', 'helper'];
const LEVEL_LABELS = { admin: 'Administrador', mod: 'Moderador', helper: 'Helper' };
const FEATURE_LABELS = {
  welcome: 'Bienvenida',
  autorole: 'Autorol',
  modlog: 'Mod-log',
  logs: 'Logs',
  avisos: 'Avisos al staff',
  mute: 'Rol de silenciado',
  ia: 'Chat con IA',
};

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
        .setName('logs')
        .setDescription('Canal donde se registran mensajes borrados/editados, salidas y cambios de roles')
        .addChannelOption((o) =>
          o
            .setName('canal')
            .setDescription('Canal de registro general')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('avisos')
        .setDescription('Canal donde el bot envía las notificaciones al staff')
        .addChannelOption((o) =>
          o
            .setName('canal')
            .setDescription('Canal de notificaciones al staff')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('mute')
        .setDescription('Define el rol que se usa para silenciar (por defecto se crea uno llamado Silenciado)')
        .addRoleOption((o) =>
          o
            .setName('rol')
            .setDescription('Rol de silenciado (debe tener los permisos bloqueados en los canales)')
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('ia')
        .setDescription('Prende o apaga el chat con IA cuando alguien menciona al bot')
        .addBooleanOption((o) =>
          o
            .setName('activada')
            .setDescription('Dejar vacío para ver el estado actual')
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
              { name: 'Registro de moderación (mod-log)', value: 'modlog' },
              { name: 'Registro de eventos (logs)', value: 'logs' },
              { name: 'Avisos al staff', value: 'avisos' },
              { name: 'Rol de silenciado (/mute)', value: 'mute' },
              { name: 'Chat con IA (menciones)', value: 'ia' }
            )
        )
    ),

  async execute(interaction) {
    if (!isMod(interaction)) {
      return interaction.reply({ embeds: [errorEmbed('No tenés permiso para usar /config.')], flags: MessageFlags.Ephemeral });
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

      const logsChannel = config.logs ? `<#${config.logs}>` : null;
      const avisos = config.avisosChannel ? `<#${config.avisosChannel}>` : null;
      const muteRole = config.muteRole ? `<@&${config.muteRole}>` : null;
      const iaEstado = config.iaActivada === false ? '❌ Apagada' : '✅ Prendida';

      const embed = new EmbedBuilder()
        .setTitle('⚙️ Configuración de TriggerBOT')
        .setColor(0x5865f2)
        .addFields(
          { name: 'Bienvenida', value: estado(welcomeChannel, welcomeChannel), inline: true },
          { name: 'Autorol', value: estado(autorole, autorole), inline: true },
          { name: 'Mod-log', value: estado(modlog, modlog), inline: true },
          { name: 'Logs', value: estado(logsChannel, logsChannel), inline: true },
          { name: 'Avisos al staff', value: estado(avisos, avisos), inline: true },
          { name: 'Rol de silenciado', value: estado(muteRole, muteRole), inline: true },
          { name: 'Chat con IA', value: iaEstado, inline: true },
          { name: 'Mensaje de bienvenida', value: config.welcome?.message || '*(por defecto)*', inline: false },
          { name: 'Staff del bot', value: staffLines, inline: false }
        );
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'welcome') {
      const channelId = interaction.options.getChannel('canal')?.id ?? null;
      const message = interaction.options.getString('mensaje');
      const role = interaction.options.getRole('autorol');

      if (channelId === null && message === null && role === null) {
        return interaction.reply({
          embeds: [warnEmbed('No pasaste ninguna opción. Pasá al menos una para cambiar algo.')],
          flags: MessageFlags.Ephemeral,
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
      return interaction.reply({ embeds: [successEmbed(`Bienvenida actualizada (${parts.join(', ')}).`)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'modlog') {
      const channel = interaction.options.getChannel('canal');
      store.setGuildConfig(interaction.guildId, (c) => {
        c.modlog = channel.id;
      });
      return interaction.reply({ embeds: [successEmbed(`Mod-log configurado en ${channel}.`)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'logs') {
      const channel = interaction.options.getChannel('canal');
      store.setGuildConfig(interaction.guildId, (c) => {
        c.logs = channel.id;
      });
      return interaction.reply({ embeds: [successEmbed(`Registro de eventos configurado en ${channel}.`)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'avisos') {
      const channel = interaction.options.getChannel('canal');
      store.setGuildConfig(interaction.guildId, (c) => {
        c.avisosChannel = channel.id;
      });
      return interaction.reply({ embeds: [successEmbed(`Avisos al staff configurados en ${channel}.`)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'mute') {
      const role = interaction.options.getRole('rol');
      store.setGuildConfig(interaction.guildId, (c) => {
        c.muteRole = role.id;
      });
      return interaction.reply({
        embeds: [successEmbed(`Rol de silenciado configurado: ${role}. Verificá que tenga el habla bloqueado en los canales.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'ia') {
      const activada = interaction.options.getBoolean('activada');

      if (activada === null) {
        const actual = config.iaActivada === false ? '❌ apagada' : '✅ prendida';
        return interaction.reply({
          embeds: [successEmbed(`El chat con IA está ${actual}. Pasame la opción \`activada\` para cambiarlo.`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      store.setGuildConfig(interaction.guildId, (c) => {
        c.iaActivada = activada;
      });
      return interaction.reply({
        embeds: [successEmbed(`Chat con IA ${activada ? '✅ prendido' : '❌ apagado'} en este servidor.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'staff') {
      const admin = interaction.options.getRole('admin');
      const mod = interaction.options.getRole('mod');
      const helper = interaction.options.getRole('helper');

      if (!admin && !mod && !helper) {
        return interaction.reply({
          embeds: [warnEmbed('Pasá al menos un rol (admin, mod o helper).')],
          flags: MessageFlags.Ephemeral,
        });
      }

      store.setGuildConfig(interaction.guildId, (c) => {
        if (admin) c.adminRole = admin.id;
        if (mod) c.modRole = mod.id;
        if (helper) c.helperRole = helper.id;
      });
      return interaction.reply({ embeds: [successEmbed('Roles de staff actualizados.')], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'desactivar') {
      const feature = interaction.options.getString('funcion');
      store.setGuildConfig(interaction.guildId, (c) => {
        if (feature === 'welcome') delete c.welcome;
        if (feature === 'autorole') delete c.autorole;
        if (feature === 'modlog') delete c.modlog;
        if (feature === 'logs') delete c.logs;
        if (feature === 'avisos') delete c.avisosChannel;
        if (feature === 'mute') delete c.muteRole;
        if (feature === 'ia') delete c.iaActivada;
      });
      return interaction.reply({ embeds: [successEmbed(`Función **${FEATURE_LABELS[feature] ?? feature}** desactivada.`)], flags: MessageFlags.Ephemeral });
    }
  },
};
