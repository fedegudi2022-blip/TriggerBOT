const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { autocompletar } = require('../utils/plantillas');
const { quiereSilencioso, diferir, resolverMiembro, intentar } = require('../utils/acciones');

// Permisos que se niegan con el rol Silenciado. Los usa también el evento
// channelCreate (events/channelCreate.js) para que un canal creado DESPUÉS de que
// el rol exista no quede sin la restricción — el agujero que tenía antes.
const DENEGADOS_MUTE = { SendMessages: false, AddReactions: false, Speak: false, Connect: false };

// Devuelve el rol de silenciado configurado. Si no existe, lo crea y le niega los
// permisos de habla/escritura en todos los canales donde el bot puede hacerlo.
async function asegurarRolMute(guild) {
  const config = getGuildConfig(guild.id);
  if (config.muteRole) {
    const existente = guild.roles.cache.get(config.muteRole);
    if (existente) return existente;
  }

  const role = await guild.roles.create({
    name: 'Silenciado',
    color: COLORS.gris,
    reason: 'Rol de silenciado creado automáticamente por TriggerBOT',
  });

  const canales = guild.channels.cache.filter(
    (c) => [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement].includes(c.type) && c.manageable
  );
  // En paralelo: un servidor con 60 canales tardaba 60 viajes secuenciales.
  // Cada canal reporta su error por separado: si uno falla, el resto se aplica igual.
  await Promise.all([...canales.values()].map((canal) => canal.permissionOverwrites.edit(role, DENEGADOS_MUTE).catch(() => {})));

  setGuildConfig(guild.id, (c) => {
    c.muteRole = role.id;
  });
  return role;
}

module.exports = {
  asegurarRolMute,
  DENEGADOS_MUTE,

  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Silencia a un usuario con el rol Silenciado (hasta que alguien lo quite)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a silenciar').setRequired(true))
    .addStringOption((o) =>
      o.setName('razon').setDescription('Motivo del silencio (escribí para ver plantillas)').setMaxLength(500).setAutocomplete(true)
    )
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async autocomplete(interaction) {
    return autocompletar(interaction);
  },

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);

    const member = await resolverMiembro(interaction);

    const error =
      motivoNoModerable(interaction, member) ?? (member?.manageable ? null : 'No puedo darle el rol: su rol más alto está por encima del mío.');
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    const config = getGuildConfig(interaction.guild.id);
    const yaTieneRol = config.muteRole && member.roles.cache.has(config.muteRole);
    if (yaTieneRol) {
      return interaction.reply({ embeds: [errorEmbed(`${user} ya está silenciado con el rol Silenciado.`)], flags: MessageFlags.Ephemeral });
    }

    await diferir(interaction, silencioso);

    let role;
    try {
      role = await asegurarRolMute(interaction.guild);
    } catch (err) {
      return interaction.editReply({
        embeds: [errorEmbed(`No pude crear el rol **Silenciado**.\n> ${err.message}\n\nVerificá que tenga permiso de **Gestionar roles**.`)],
      });
    }

    const resultado = await intentar('Discord rechazó asignar el rol de silenciado', () =>
      member.roles.add(role, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`)
    );

    const caso = logAction(interaction.guild, {
      action: resultado.ok ? 'Silencio (mute)' : 'Silencio (mute) — rechazado',
      color: resultado.ok ? COLORS.error : COLORS.warn,
      target: user,
      moderator: interaction.user,
      reason,
      duration: resultado.ok ? 'Indefinido' : undefined,
      extra: resultado.ok ? undefined : resultado.error,
    });

    if (!resultado.ok) {
      return interaction.editReply({
        embeds: [errorEmbed(`No se pudo silenciar a ${user}.\n> ${resultado.error}`, 'La acción no se aplicó')],
      });
    }

    void avisarPorDM(user, `🔇 Fuiste silenciado en **${interaction.guild.name}**.\n**Motivo:** ${reason || 'no especificado'}`);

    return interaction.editReply({
      embeds: [
        accionEmbed({
          titulo: '🔇 Silencio (rol)',
          detalle: `${user} quedó silenciado con el rol ${role}.`,
          motivo: reason,
          duracionTexto: 'Indefinido — hasta que lo quite /unmute',
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          thumbnail: user.displayAvatarURL({ size: 128 }),
          footer: 'el bot aplica el rol a los canales nuevos automáticamente',
        }),
      ],
    });
  },
};
