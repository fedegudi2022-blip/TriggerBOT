const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { PermissionFlagsBits } = require('discord.js');
const { listar, agregar, quitar } = require('../utils/plantillas');
const { infoEmbed, warnEmbed, successEmbed, errorEmbed } = require('../utils/replies');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('plantillas')
    .setDescription('Razones rápidas para sanciones (aparecen como autocompletado en /warn, /ban, etc.)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('agregar')
        .setDescription('Agrega una plantilla de razón')
        .addStringOption((o) => o.setName('nombre').setDescription('Nombre corto (ej: Spam, Toxicidad, Raid)').setRequired(true).setMaxLength(50))
        .addStringOption((o) => o.setName('razon').setDescription('Razón completa que se carga al elegirla').setRequired(true).setMaxLength(400))
    )
    .addSubcommand((sc) =>
      sc
        .setName('quitar')
        .setDescription('Elimina una plantilla')
        .addStringOption((o) => o.setName('nombre').setDescription('Nombre de la plantilla').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) => sc.setName('lista').setDescription('Muestra todas las plantillas cargadas')),

  // Autocompletado del nombre a quitar: sugiere las plantillas existentes.
  async autocomplete(interaction) {
    if (interaction.options.getSubcommand() !== 'quitar') return interaction.respond([]);
    const tipeado = String(interaction.options.getFocused() ?? '').toLowerCase();
    const opciones = Object.keys(listar(interaction.guildId))
      .filter((nombre) => nombre.toLowerCase().includes(tipeado))
      .slice(0, 25)
      .map((nombre) => ({ name: nombre, value: nombre }));
    await interaction.respond(opciones);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'agregar') {
      const nombre = interaction.options.getString('nombre', true).trim();
      const razon = interaction.options.getString('razon', true).trim();
      agregar(interaction.guildId, nombre, razon);
      return interaction.reply({
        embeds: [successEmbed(`Plantilla **${nombre}** guardada. Ahora aparece como sugerencia en los comandos de moderación.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'quitar') {
      const nombre = interaction.options.getString('nombre', true).trim();
      if (quitar(interaction.guildId, nombre)) {
        return interaction.reply({ embeds: [successEmbed(`Plantilla **${nombre}** eliminada.`)], flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ embeds: [errorEmbed('Esa plantilla no existe.')], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'lista') {
      const plantillas = listar(interaction.guildId);
      const entradas = Object.entries(plantillas);
      if (!entradas.length) {
        return interaction.reply({
          embeds: [warnEmbed('No hay plantillas cargadas todavía. Creá la primera con `/plantillas agregar`.', 'Plantillas de sanciones')],
          flags: MessageFlags.Ephemeral,
        });
      }
      const cuerpo = entradas.map(([nombre, razon]) => `**${nombre}** — ${razon}`).join('\n');
      return interaction.reply({
        embeds: [infoEmbed(cuerpo.slice(0, 4000), `Plantillas de sanciones (${entradas.length})`)],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
