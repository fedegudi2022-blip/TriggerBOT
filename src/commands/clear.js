const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, COLORS } = require('../utils/replies');
// El límite de 14 días de Discord (y el 2-100 por llamada) vive en utils/acciones.js:
// lo comparten este comando y las órdenes por chat con IA, para no responder con un
// error engañoso ni perder el pedido del staff.
const { quiereSilencioso, diferir, LIMITE_14_DIAS_MS } = require('../utils/acciones');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Borra mensajes masivamente en este canal')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) =>
      o.setName('cantidad').setDescription('Cantidad de mensajes a borrar (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)
    )
    .addUserOption((o) => o.setName('usuario').setDescription('Borrar solo mensajes de este usuario'))
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del borrado').setMaxLength(500))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async execute(interaction) {
    const amount = interaction.options.getInteger('cantidad', true);
    const user = interaction.options.getUser('usuario');
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);

    if (!interaction.channel?.isTextBased?.() && !interaction.channel?.messages) {
      return interaction.reply({ embeds: [errorEmbed('Este canal no permite borrar mensajes.')], flags: MessageFlags.Ephemeral });
    }

    await diferir(interaction, silencioso);

    // Con filtro por usuario hay que traer de más: se piden hasta 5×cantidad
    // (tope 400) y se borran SOLO los que coinciden, hasta llegar a la cuenta pedida.
    const aBuscar = user ? Math.min(amount * 5, 400) : amount;

    const mensajes = await interaction.channel.messages.fetch({ limit: aBuscar }).catch(() => null);
    if (!mensajes) {
      return interaction.editReply({
        embeds: [errorEmbed('No pude leer los mensajes del canal. Verificá que tenga permiso de **Leer historial**.')],
      });
    }

    const candidatos = [...mensajes.values()].filter((m) => !user || m.author.id === user.id);
    const frescos = candidatos.filter((m) => Date.now() - m.createdTimestamp < LIMITE_14_DIAS_MS);
    const viejos = candidatos.length - frescos.length; // Discord no los borra en bloque
    const aBorrar = frescos.slice(0, amount);

    if (!aBorrar.length) {
      const quien = user ? ` de **${user.tag}**` : '';
      return interaction.editReply({
        embeds: [
          errorEmbed(
            viejos
              ? `Los **${viejos}** mensaje(s)${quien} que encontré tienen más de 14 días: Discord no permite borrarlos en bloque. Se borran a mano.`
              : `No encontré mensajes${quien} para borrar en este canal.`,
            'No borré nada'
          ),
        ],
      });
    }

    // Un solo mensaje no se puede borrar en bloque (Discord exige 2 a 100).
    let borrados = 0;
    let error = null;
    if (aBorrar.length === 1) {
      const unico = await aBorrar[0].delete().catch((e) => e);
      if (unico instanceof Error) error = unico;
      else borrados = 1;
    } else {
      const resultado = await interaction.channel.bulkDelete(aBorrar, true).catch((e) => e);
      if (resultado instanceof Error) error = resultado;
      else borrados = resultado.size;
    }

    if (error) {
      return interaction.editReply({
        embeds: [errorEmbed(`No pude borrar los mensajes.\n> ${error.message}`, 'No se aplicó el borrado')],
      });
    }

    const caso = logAction(interaction.guild, {
      action: 'Borrado masivo (clear)',
      color: COLORS.warn,
      target: user ?? { raw: `Canal ${interaction.channel} (\`#${interaction.channel.name}\`)` },
      moderator: interaction.user,
      reason,
      extra: `Canal: <#${interaction.channelId}> — ${borrados} mensaje(s)` + (viejos ? ` · ${viejos} con más de 14 días quedaron afuera` : ''),
    });

    const confirmacion = await interaction.editReply({
      embeds: [
        accionEmbed({
          titulo: '🧹 Limpieza',
          detalle: `Borré **${borrados}** mensaje(s)${user ? ` de ${user}` : ''}.`,
          motivo: reason,
          caso,
          moderador: interaction.member?.displayName ?? interaction.user.username,
          campos: viejos
            ? [{ name: 'Quedaron afuera', value: `**${viejos}** mensaje(s) con más de 14 días (Discord no los borra en bloque).`, inline: false }]
            : [],
        }),
      ],
    });

    // La confirmación pública se borra sola a los 5 s: el canal queda limpio y el
    // registro sigue en el mod-log. Si el staff pidió modo silencioso, la ve solo él.
    if (!silencioso) {
      setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
    }
    return confirmacion;
  },
};
