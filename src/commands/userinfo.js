const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { brandEmbed } = require('../utils/replies');
const { getWarns } = require('../warns');

const PERMISOS_INTERESANTES = [
  ['Administrador', PermissionFlagsBits.Administrator],
  ['Gestionar servidor', PermissionFlagsBits.ManageGuild],
  ['Banear', PermissionFlagsBits.BanMembers],
  ['Expulsar', PermissionFlagsBits.KickMembers],
  ['Moderar miembros', PermissionFlagsBits.ModerateMembers],
  ['Gestionar mensajes', PermissionFlagsBits.ManageMessages],
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Muestra la ficha completa de un usuario')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar (vacío = vos)')),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario') ?? interaction.user;
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const creado = `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`;
    const unido = member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : '*desconocido*';

    const permisos = member
      ? PERMISOS_INTERESANTES.filter(([, p]) => member.permissions.has(p)).map(([nombre]) => nombre)
      : [];
    const roles = member
      ? member.roles.cache
          .filter((r) => r.id !== interaction.guild.id)
          .sort((a, b) => b.position - a.position)
          .map((r) => `<@&${r.id}>`)
          .join(' ')
      : '';
    const warns = getWarns(interaction.guild.id, user.id).length;

    const embed = brandEmbed({
      color: member?.displayColor || 0x5865f2,
      title: user.tag,
      thumbnail: user.displayAvatarURL({ size: 256 }),
      fields: [
        { name: 'ID', value: `\`${user.id}\``, inline: true },
        { name: 'Cuenta creada', value: creado, inline: true },
        { name: 'Se unió', value: unido, inline: true },
        { name: 'Advertencias', value: `${warns}`, inline: true },
        { name: 'Es bot', value: user.bot ? 'Sí' : 'No', inline: true },
        {
          name: 'Roles destacados',
          value: permisos.length ? permisos.map((p) => `\`${p}\``).join(', ') : '*ninguno*',
          inline: false,
        },
        { name: `Roles (${member ? member.roles.cache.size - 1 : 0})`, value: roles.slice(0, 1024) || '*sin roles*', inline: false },
      ],
      footer: 'TriggerBOT • /avatar para el avatar en grande',
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
