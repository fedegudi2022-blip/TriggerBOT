const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');

// Devuelve el rol de silenciado configurado. Si no existe, lo crea y le quita
// los permisos de habla/escritura en todos los canales donde el bot puede hacerlo.
async function asegurarRolMute(guild) {
  const config = getGuildConfig(guild.id);
  if (config.muteRole) {
    const existente = guild.roles.cache.get(config.muteRole);
    if (existente) return existente;
  }

  const role = await guild.roles.create({
    name: 'Silenciado',
    color: 0x99aab5,
    reason: 'Rol de silenciado creado automáticamente por TriggerBOT',
  });

  const canales = guild.channels.cache.filter(
    (c) => [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement].includes(c.type) && c.manageable
  );
  for (const canal of canales.values()) {
    await canal.permissionOverwrites
      .edit(role, { SendMessages: false, AddReactions: false, Speak: false, Connect: false })
      .catch(() => {});
  }

  setGuildConfig(guild.id, (c) => {
    c.muteRole = role.id;
  });
  return role;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Silencia a un usuario con el rol Silenciado (hasta que alguien lo quite)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a silenciar').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del silencio').setMaxLength(500)),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const error = motivoNoModerable(interaction, member);
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    let role;
    try {
      role = await asegurarRolMute(interaction.guild);
    } catch (err) {
      console.error(`[TriggerBOT] No se pudo preparar el rol de silenciado: ${err.message}`);
      return interaction.editReply({
        embeds: [errorEmbed('No pude crear el rol **Silenciado**. Verificá que el bot tenga permiso de **Gestionar roles**.')],
      });
    }

    if (member.roles.cache.has(role.id)) {
      return interaction.editReply({ embeds: [errorEmbed(`${user} ya está silenciado.`)] });
    }

    await member.roles.add(role, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`);
    await avisarPorDM(user, `🔇 Fuiste silenciado en **${interaction.guild.name}**.\n**Motivo:** ${reason || '*sin especificar*'}`);

    await interaction.editReply({
      embeds: [successEmbed(`${user} quedó silenciado. Usá /unmute para revertirlo.`)],
    });

    logAction(interaction.guild, {
      action: 'Silencio (mute)',
      target: user,
      moderator: interaction.user,
      reason,
      duration: 'Indefinido',
    });
  },
};
