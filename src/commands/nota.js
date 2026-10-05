// /nota — notas internas del staff sobre un usuario.
//
// Se guardan aparte de los warns a propósito: una nota es una observación
// ("habló con el staff", "ya se le avisó") que NO cuenta para el silencio
// automático de 3 advertencias. Si vivieran en el historial de warns, una
// observación terminaría sancionando.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getNotas, addNota, removeNota } = require('../notas');
const { nombreDe, brandEmbed, COLORS } = require('../utils/replies');
const { exigirStaff } = require('../utils/permisos');

const fecha = (ts) => `<t:${Math.floor(ts / 1000)}:d>`;

function vista(usuario, notas) {
  if (!notas.length) {
    return brandEmbed({
      color: COLORS.success,
      title: `Notas de ${nombreDe(usuario)}`,
      description: 'Sin notas internas.',
      thumbnail: usuario.displayAvatarURL?.({ size: 128 }),
    });
  }
  const cuerpo = notas.map((n, i) => `**#${i + 1}** — ${fecha(n.timestamp)} por <@${n.moderatorId}>\n> ${n.texto}`).join('\n\n');
  return brandEmbed({
    color: COLORS.info,
    title: `Notas de ${nombreDe(usuario)} (${notas.length})`,
    description: cuerpo.slice(0, 4000),
    thumbnail: usuario.displayAvatarURL?.({ size: 128 }),
    footer: 'TriggerBOT • las notas NO cuentan como advertencias • /nota quitar para borrar',
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nota')
    .setDescription('Notas internas sobre un usuario (no cuentan como advertencias)')
    .addSubcommand((sc) =>
      sc
        .setName('agregar')
        .setDescription('Agrega una nota interna')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario al que se refiere la nota').setRequired(true))
        .addStringOption((o) => o.setName('texto').setDescription('Contenido de la nota').setRequired(true).setMaxLength(500))
    )
    .addSubcommand((sc) =>
      sc
        .setName('ver')
        .setDescription('Muestra las notas de un usuario')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar').setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('quitar')
        .setDescription('Elimina una nota por su número')
        .addUserOption((o) => o.setName('usuario').setDescription('Dueño de la nota').setRequired(true))
        .addIntegerOption((o) => o.setName('numero').setDescription('Número de la nota (empezando en 1)').setRequired(true).setMinValue(1))
    ),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ModerateMembers, 'Las notas internas son solo para el staff.'))) return;

    const sub = interaction.options.getSubcommand();
    const usuario = interaction.options.getUser('usuario', true);
    const guildId = interaction.guildId;

    if (sub === 'agregar') {
      const texto = interaction.options.getString('texto', true).trim();
      addNota(guildId, usuario.id, { texto, moderatorId: interaction.user.id, timestamp: Date.now() });
      const total = getNotas(guildId, usuario.id).length;
      return interaction.reply({
        embeds: [
          brandEmbed({
            color: COLORS.success,
            title: 'Nota guardada',
            description: `Anoté algo sobre ${usuario} (${total} nota(s) en total). **No cuenta como advertencia.**`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'ver') {
      return interaction.reply({ embeds: [vista(usuario, getNotas(guildId, usuario.id))], flags: MessageFlags.Ephemeral });
    }

    // quitar
    const numero = interaction.options.getInteger('numero', true);
    const quitada = removeNota(guildId, usuario.id, numero);
    if (!quitada) {
      return interaction.reply({
        embeds: [brandEmbed({ color: COLORS.warn, title: 'No encontré esa nota', description: `${usuario} no tiene una nota #${numero}.` })],
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      embeds: [brandEmbed({ color: COLORS.success, title: 'Nota eliminada', description: `Borré la nota #${numero} de ${usuario}.` })],
      flags: MessageFlags.Ephemeral,
    });
  },
};
