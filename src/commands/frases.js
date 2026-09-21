const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { brandEmbed, successEmbed, errorEmbed } = require('../utils/replies');

// Frases del día por servidor: { canal, hora, frases: [{ texto, autor }], ultima }.
// El scheduler global las publica una vez por día a la hora configurada.

module.exports = {
  data: new SlashCommandBuilder()
    .setName('frases')
    .setDescription('Configura la frase del día que el bot publica automáticamente (solo staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('configurar')
        .setDescription('Define el canal y la hora de publicación (hora de Argentina)')
        .addChannelOption((o) => o.setName('canal').setDescription('Canal donde se publica la frase').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('hora').setDescription('Hora del día en formato 24h (0-23, hora de Argentina)').setRequired(true).setMinValue(0).setMaxValue(23)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('agregar')
        .setDescription('Agrega una frase al rotativo')
        .addStringOption((o) => o.setName('texto').setDescription('La frase o meme del día').setRequired(true).setMaxLength(300))
        .addStringOption((o) => o.setName('autor').setDescription('Autor de la frase (opcional)').setMaxLength(100))
    )
    .addSubcommand((sc) => sc.setName('publicar').setDescription('Publica una frase ahora mismo, sin esperar la hora'))
    .addSubcommand((sc) => sc.setName('lista').setDescription('Muestra todas las frases cargadas'))
    .addSubcommand((sc) =>
      sc
        .setName('quitar')
        .setDescription('Elimina una frase por su número')
        .addIntegerOption((o) => o.setName('numero').setDescription('Número de la frase en /frases lista').setRequired(true).setMinValue(1))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const config = getGuildConfig(interaction.guildId);

    if (sub === 'configurar') {
      const canal = interaction.options.getChannel('canal', true);
      const hora = interaction.options.getInteger('hora', true);
      setGuildConfig(interaction.guildId, (c) => {
        c.fraseDelDia = { canalId: canal.id, hora, frases: c.fraseDelDia?.frases ?? [], ultima: c.fraseDelDia?.ultima ?? null };
      });
      return interaction.reply({
        embeds: [successEmbed(`Frase del día configurada: se publica en ${canal} a las **${hora}:00** (hora de Argentina).\nAgregá frases con \`/frases agregar\`.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'agregar') {
      const texto = interaction.options.getString('texto', true).trim();
      const autor = interaction.options.getString('autor')?.trim() || interaction.user.username;
      setGuildConfig(interaction.guildId, (c) => {
        c.fraseDelDia = c.fraseDelDia || { canalId: null, hora: 12, frases: [], ultima: null };
        c.fraseDelDia.frases.push({ texto, autor });
      });
      const total = (config.fraseDelDia?.frases?.length ?? 0) + 1;
      return interaction.reply({
        embeds: [successEmbed(`Frase agregada (van **${total}** en el rotativo).`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'publicar') {
      const frases = config.fraseDelDia?.frases ?? [];
      if (!frases.length) {
        return interaction.reply({ embeds: [errorEmbed('No hay frases cargadas. Agregá la primera con `/frases agregar`.')], flags: MessageFlags.Ephemeral });
      }
      const frase = frases[Math.floor(Math.random() * frases.length)];
      const embed = brandEmbed({
        color: 0x5865f2,
        title: 'Frase del día',
        description: `> ${frase.texto}`,
        footer: `— ${frase.autor} • TriggerBOT`,
      });
      await interaction.channel.send({ embeds: [embed] });
      return interaction.reply({ embeds: [successEmbed('Frase publicada en este canal.')], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'lista') {
      const frases = config.fraseDelDia?.frases ?? [];
      if (!frases.length) {
        return interaction.reply({ embeds: [errorEmbed('No hay frases cargadas todavía.')], flags: MessageFlags.Ephemeral });
      }
      const cuerpo = frases.map((f, i) => `**${i + 1}.** ${f.texto} — *${f.autor}*`).join('\n');
      return interaction.reply({
        embeds: [brandEmbed({ color: 0x5865f2, title: `Frases del día (${frases.length})`, description: cuerpo.slice(0, 4000) })],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'quitar') {
      const numero = interaction.options.getInteger('numero', true);
      const frases = config.fraseDelDia?.frases ?? [];
      if (numero > frases.length) {
        return interaction.reply({ embeds: [errorEmbed(`Solo hay ${frases.length} frase(s).`)], flags: MessageFlags.Ephemeral });
      }
      setGuildConfig(interaction.guildId, (c) => {
        c.fraseDelDia.frases.splice(numero - 1, 1);
      });
      return interaction.reply({ embeds: [successEmbed(`Frase #${numero} eliminada.`)], flags: MessageFlags.Ephemeral });
    }
  },
};
