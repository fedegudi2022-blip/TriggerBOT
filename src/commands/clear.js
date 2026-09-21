const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { successEmbed, errorEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Borra mensajes masivamente en este canal')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) =>
      o
        .setName('cantidad')
        .setDescription('Cantidad de mensajes a borrar (1-100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .addUserOption((o) => o.setName('usuario').setDescription('Borrar solo mensajes de este usuario'))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del borrado').setMaxLength(500)),

  async execute(interaction) {
    const amount = interaction.options.getInteger('cantidad', true);
    const user = interaction.options.getUser('usuario');
    const reason = interaction.options.getString('razon');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Con filtro por usuario hay que traer de más: se piden hasta 5×cantidad
    // (tope 400) y se borran SOLO los que coinciden, hasta llegar a la cuenta pedida.
    const aBuscar = user ? Math.min(amount * 5, 400) : amount;

    const mensajes = await interaction.channel.messages.fetch({ limit: aBuscar }).catch((error) => {
      console.error(`[TriggerBOT] Error al fetch de mensajes: ${error.message}`);
      return null;
    });

    if (!mensajes) {
      return interaction.editReply({
        embeds: [errorEmbed('No pude leer los mensajes del canal. Verificá que tenga permiso de **Leer historial**.')],
      });
    }

    // Filtra por usuario (si corresponde) y toma solo la cantidad pedida.
    const aBorrar = [...mensajes.values()]
      .filter((m) => !user || m.author.id === user.id)
      .slice(0, amount);

    if (aBorrar.length === 0) {
      const quien = user ? ` de **${user.tag}**` : '';
      return interaction.editReply({
        embeds: [errorEmbed(`No encontré mensajes${quien} para borrar en este canal.`)],
      });
    }

    const borrados = await interaction.channel.bulkDelete(aBorrar, true).catch((error) => {
      console.error(`[TriggerBOT] Error en bulkDelete: ${error.message}`);
      return null;
    });

    if (!borrados) {
      return interaction.editReply({
        embeds: [errorEmbed('No pude borrar mensajes. Discord no permite borrar mensajes de más de 14 días.')],
      });
    }

    const deleted = borrados.size;
    const who = user ? ` de ${user}` : '';
    await interaction.editReply({ embeds: [successEmbed(`Borré **${deleted}** mensaje(s)${who}.`, '🧹 Limpieza')] });

    // Auto-borra la confirmación a los 5 segundos
    setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);

    logAction(interaction.guild, {
      action: 'Borrado masivo (clear)',
      color: 0xfee75c,
      target: user ?? { raw: `Canal ${interaction.channel} (\`#${interaction.channel.name}\`)` },
      moderator: interaction.user,
      reason,
      extra: `Canal: <#${interaction.channelId}> — ${deleted} mensaje(s)`,
    });
  },
};
