// /reportar — cualquier miembro puede reportar a un cheater sin pasar por el panel.
// Abre el mismo ticket de tipo "reporte" que el selector: el staff lo ve, lo reclama
// y queda el transcript al cerrarlo. Con pruebas (texto y, si hace falta, un link a la
// captura, el video o la demo), que es lo que hace que el reporte sirva.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { errorEmbed } = require('../utils/replies');
const { abrirTicket } = require('../utils/tickets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reportar')
    .setDescription('Reportá a un cheater o a alguien que rompe las reglas (abre un ticket privado)')
    .addUserOption((o) => o.setName('usuario').setDescription('A quién reportás').setRequired(true))
    .addStringOption((o) => o.setName('pruebas').setDescription('Qué hizo y qué pruebas tenés (mapa, hora, demo…)').setMaxLength(500).setRequired(true))
    .addStringOption((o) => o.setName('adjunto').setDescription('Link a la captura, el video o la demo (opcional)').setMaxLength(200))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Que el mensaje de confirmación lo vea solo yo')),

  async execute(interaction) {
    const reportado = interaction.options.getUser('usuario', true);
    const pruebas = interaction.options.getString('pruebas', true);
    const adjunto = interaction.options.getString('adjunto');
    const silencioso = interaction.options.getBoolean('silencioso') === true;

    await interaction.deferReply(silencioso ? { flags: MessageFlags.Ephemeral } : {});

    if (reportado.bot) {
      return interaction.editReply({ embeds: [errorEmbed('No se puede reportar a un bot: si un bot molesta, avisale a un admin del server.')] });
    }
    if (reportado.id === interaction.user.id) {
      return interaction.editReply({ embeds: [errorEmbed('No te podés reportar a vos mismo.')] });
    }

    const resultado = await abrirTicket(interaction, {
      tipo: 'reporte',
      campos: {
        reportado: `${reportado.username} (${reportado.id})`,
        pruebas,
        adjunto: adjunto || 'No adjuntó link: pedile las pruebas en el ticket.',
      },
    });

    if (resultado.error) {
      return interaction.editReply({ embeds: [errorEmbed(resultado.error)] });
    }

    return interaction.editReply({
      content:
        `Gracias por avisar. Tu reporte quedó en ${resultado.canal} como **Ticket #${String(resultado.numero).padStart(3, '0')}**.\n` +
        'El staff lo va a revisar: si tenés capturas, video o la demo, pegalos ahí (los adjuntos suman mucho).',
    });
  },
};
