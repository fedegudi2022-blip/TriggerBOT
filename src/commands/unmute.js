const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../store');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS, marcaTiempo } = require('../utils/replies');
const { motivoNoModerable, avisarPorDM } = require('../utils/moderation');
const { quiereSilencioso, diferir, resolverMiembro, intentar } = require('../utils/acciones');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Le quita el silencio a un usuario')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a des-silenciar').setRequired(true))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del des-silencio').setMaxLength(500))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async execute(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);

    const member = await resolverMiembro(interaction);

    const error =
      motivoNoModerable(interaction, member) ?? (member?.manageable ? null : 'No puedo quitarle el rol: su rol más alto está por encima del mío.');
    if (error) {
      return interaction.reply({ embeds: [errorEmbed(error)], flags: MessageFlags.Ephemeral });
    }

    const muteRole = getGuildConfig(interaction.guild.id).muteRole;
    if (!muteRole || !member.roles.cache.has(muteRole)) {
      return interaction.reply({
        embeds: [
          errorEmbed(
            `${user} no está silenciado con el rol Silenciado.` +
              (member.communicationDisabledUntilTimestamp
                ? '\n> Tiene un **silencio temporal** activo: se levanta con `/timeout` → *Quitarlo ahora*.'
                : '')
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    await diferir(interaction, silencioso);

    const resultado = await intentar('Discord rechazó quitar el rol de silenciado', () =>
      member.roles.remove(muteRole, reason ? `${reason} — por ${interaction.user.tag}` : `por ${interaction.user.tag}`)
    );

    const caso = logAction(interaction.guild, {
      action: resultado.ok ? 'Des-silencio (unmute)' : 'Des-silencio (unmute) — rechazado',
      color: resultado.ok ? COLORS.success : COLORS.warn,
      target: user,
      moderator: interaction.user,
      reason,
      extra: resultado.ok ? undefined : resultado.error,
    });

    if (!resultado.ok) {
      return interaction.editReply({
        embeds: [errorEmbed(`No se pudo quitar el silencio a ${user}.\n> ${resultado.error}`, 'La acción no se aplicó')],
      });
    }

    void avisarPorDM(user, `🔊 Ya no estás silenciado en **${interaction.guild.name}**. ¡Bienvenido de vuelta!`);

    // Si además tenía un timeout activo, el rol no alcanza: se lo aclaramos al staff.
    const timeoutActivo = member.communicationDisabledUntilTimestamp;
    return interaction.editReply({
      embeds: [
        accionEmbed({
          titulo: '🔊 Silencio levantado',
          detalle: `${user} puede volver a hablar.`,
          motivo: reason,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          thumbnail: user.displayAvatarURL({ size: 128 }),
          campos:
            timeoutActivo && new Date(timeoutActivo).getTime() > Date.now()
              ? [
                  {
                    name: '⚠️ Ojo: sigue con un silencio temporal',
                    value: `Tiene un timeout activo hasta ${marcaTiempo(timeoutActivo)} — levantalo con \`/timeout\` → *Quitarlo ahora*.`,
                    inline: false,
                  },
                ]
              : [],
        }),
      ],
    });
  },
};
