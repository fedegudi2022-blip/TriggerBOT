// /ticket — publica el panel de soporte y configura dónde viven los tickets.
// Subcomandos:
//   publicar  (staff)  → manda el panel con el botón "Abrir ticket" al canal actual
//   categoria (staff)  → categoría donde se crean los canales de ticket
//   logs      (staff)  → canal donde quedan los transcripts al cerrar
//   mensaje   (staff)  → texto del panel (el embed de bienvenida del canal de soporte)
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { successEmbed, errorEmbed } = require('../utils/replies');
const { panel } = require('../utils/tickets');
const { setGuildConfig } = require('../store');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Sistema de tickets de soporte')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('publicar').setDescription('Publicar el panel de soporte en este canal'))
    .addSubcommand((s) =>
      s
        .setName('categoria')
        .setDescription('Categoría donde se crean los canales de ticket')
        .addChannelOption((o) => o.setName('canal').setDescription('Categoría destino').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('logs')
        .setDescription('Canal donde se guardan los transcripts al cerrar un ticket')
        .addChannelOption((o) => o.setName('canal').setDescription('Canal de logs').addChannelTypes(ChannelType.GuildText).setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('mensaje')
        .setDescription('Texto del panel de soporte (lo que ven los usuarios antes de abrir)')
        .addStringOption((o) => o.setName('texto').setDescription('Nuevo texto del panel').setMaxLength(1000).setRequired(true))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'publicar') {
      // Diferido antes del envío: publicar el panel implica una llamada a la API y
      // sin esto la interacción puede expirar.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const enviado = await interaction.channel.send(panel(guild)).catch((e) => e);
      if (enviado instanceof Error) {
        return interaction.editReply({
          embeds: [errorEmbed(`No pude publicar el panel en este canal.\n> ${enviado.message}`)],
        });
      }
      return interaction.editReply({ embeds: [successEmbed('Los usuarios ya pueden abrir tickets desde el botón del panel.')] });
    }

    if (sub === 'categoria') {
      const cat = interaction.options.getChannel('canal', true);
      setGuildConfig(guild.id, (c) => {
        c.tickets = c.tickets || {};
        c.tickets.categoriaId = cat.id;
      });
      return interaction.reply({ embeds: [successEmbed(`Los tickets se crearán en la categoría **${cat.name}**.`)] });
    }

    if (sub === 'logs') {
      const canal = interaction.options.getChannel('canal', true);
      setGuildConfig(guild.id, (c) => {
        c.tickets = c.tickets || {};
        c.tickets.canalLogs = canal.id;
      });
      return interaction.reply({ embeds: [successEmbed(`Los transcripts de tickets llegarán a ${canal}.`)] });
    }

    if (sub === 'mensaje') {
      const texto = interaction.options.getString('texto', true);
      setGuildConfig(guild.id, (c) => {
        c.tickets = c.tickets || {};
        c.tickets.mensajes = texto;
      });
      return interaction.reply({ embeds: [successEmbed('Texto actualizado. Volvé a publicar el panel con `/ticket publicar` para verlo en el canal.')] });
    }
  },
};
