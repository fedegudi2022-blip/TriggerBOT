const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { brandEmbed, COLORS } = require('../utils/replies');
const { getWarns } = require('../warns');

const PERMISOS_INTERESANTES = [
  ['Administrador', PermissionFlagsBits.Administrator],
  ['Gestionar servidor', PermissionFlagsBits.ManageGuild],
  ['Banear', PermissionFlagsBits.BanMembers],
  ['Expulsar', PermissionFlagsBits.KickMembers],
  ['Moderar miembros', PermissionFlagsBits.ModerateMembers],
  ['Gestionar mensajes', PermissionFlagsBits.ManageMessages],
];

// Antigüedad legible: "3 a 2 m" · "5 m 12 d" · "12 d".
function antiguedad(ts) {
  const dias = Math.floor((Date.now() - ts) / 86400000);
  const anios = Math.floor(dias / 365);
  const meses = Math.floor((dias % 365) / 30);
  const resto = dias % 30;
  if (anios > 0) return `${anios} a ${meses} m`;
  if (meses > 0) return `${meses} m ${resto} d`;
  return `${dias} d`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Muestra la ficha completa de un usuario')
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar (vacío = vos)')),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario') ?? interaction.user;

    // Diferido antes del fetch: la ficha se arma con datos de la API y sin esto
    // Discord corta la interacción a los 3 s.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // El miembro ya viaja resuelto con la interacción (roles, permisos, apodo y fecha
    // de ingreso incluidos): cero fetch de red para la parte de miembro.
    const member =
      interaction.options.getMember('usuario') ?? (user.id === interaction.user.id ? interaction.member : null);

    // Único fetch a la API: pide el perfil completo para banner y color de acento.
    const completo = await interaction.client.users.fetch(user.id, { force: true }).catch(() => null);

    const creado = Math.floor(user.createdTimestamp / 1000);
    const unido = member?.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;

    // Color de la ficha: el del rol más alto del miembro; si no tiene, el color
    // de acento de su banner de perfil; si tampoco, el azul del bot.
    const color = member?.displayColor || completo?.accentColor || COLORS.info;

    // Rol más alto (sin @everyone): lo usamos para la insignia de jerarquía.
    const rolTop = member?.roles.highest && member.roles.highest.id !== interaction.guild.id ? member.roles.highest : null;

    const permisos = member
      ? PERMISOS_INTERESANTES.filter(([, p]) => member.permissions.has(p)).map(([nombre]) => nombre)
      : [];

    const rolesLista = member
      ? member.roles.cache
          .filter((r) => r.id !== interaction.guild.id)
          .sort((a, b) => b.position - a.position)
          .map((r) => `<@&${r.id}>`)
          .slice(0, 15)
      : [];
    const rolesTotal = member ? member.roles.cache.size - 1 : 0;
    const rolesTexto = rolesLista.join(' ') + (rolesTotal > 15 ? ` *(+${rolesTotal - 15} más)*` : '');

    const warns = getWarns(interaction.guild.id, user.id).length;

    const embed = brandEmbed({
      color,
      title: user.tag,
      thumbnail: user.displayAvatarURL({ size: 256 }),
      description:
        (member ? `<@${user.id}>` : `**${user.tag}** (no está en el server)`) +
        (rolTop ? ` · máximo rol: <@&${rolTop.id}>` : '') +
        (user.bot ? '\n🤖 Esta cuenta es un bot' : ''),
      fields: [
        { name: '🆔 ID', value: `\`${user.id}\``, inline: true },
        { name: '📅 Cuenta creada', value: `<t:${creado}:D>\n<t:${creado}:R> · hace ${antiguedad(user.createdTimestamp)}`, inline: true },
        { name: '📥 Se unió', value: unido ? `<t:${unido}:D>\n<t:${unido}:R> · hace ${antiguedad(member.joinedTimestamp)}` : '*desconocido*', inline: true },
        { name: '🏷️ Apodo', value: member?.nickname ? member.nickname : '—', inline: true },
        { name: '⚠️ Advertencias', value: warns > 0 ? `**${warns}** warn(s)` : 'Ninguna', inline: true },
        {
          name: '🚀 Boost',
          value: member?.premiumSince ? `desde <t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>` : 'No es booster',
          inline: true,
        },
        {
          name: '🔐 Permisos destacados',
          value: permisos.length ? permisos.map((p) => `\`${p}\``).join(', ') : '*sin permisos destacados*',
          inline: false,
        },
        { name: `Roles (${rolesTotal})`, value: rolesTexto || '*sin roles*', inline: false },
      ],
      footer: `TriggerBOT • /avatar para ver su avatar en grande • en el server hace ${antiguedad(member?.joinedTimestamp ?? user.createdTimestamp)}`,
    });

    // Si el usuario tiene banner de perfil, se muestra como imagen de la ficha.
    const banner = completo?.bannerURL({ size: 1024 });
    if (banner) embed.setImage(banner);

    return interaction.editReply({ embeds: [embed] });
  },
};
