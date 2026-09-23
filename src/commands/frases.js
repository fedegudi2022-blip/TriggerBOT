const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('../store');
const { infoEmbed, warnEmbed, successEmbed, errorEmbed } = require('../utils/replies');

// Frases del día por servidor: { canal, hora, frases: [{ texto, autor }], ultima }.
// El scheduler global las publica una vez por día a la hora configurada.

// Convierte menciones <@ID> (o IDs sueltos) en nombres visibles: el footer de
// los embeds NO renderiza menciones, muestra el markup crudo. Se aplica al
// guardar y también al publicar (así las frases viejas ya guardadas quedan bien).
async function resolverAutor(guild, texto) {
  if (!texto || !texto.trim()) return 'Anónimo';
  let resultado = texto.trim();
  const patron = /<@!?(\d{17,20})>/g;
  for (const coincidencia of [...resultado.matchAll(patron)]) {
    const id = coincidencia[1];
    let nombre = null;
    try {
      const miembro = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
      nombre = miembro?.displayName ?? null;
    } catch {
      /* usuario no encontrado */
    }
    if (nombre) resultado = resultado.replaceAll(coincidencia[0], `@${nombre}`);
    else resultado = resultado.replaceAll(coincidencia[0], '@usuario'); // salió del server
  }
  // Autor = solo un ID suelto (sin markup): también se resuelve.
  if (/^\d{17,20}$/.test(resultado)) {
    const miembro = guild.members.cache.get(resultado) ?? (await guild.members.fetch(resultado).catch(() => null));
    if (miembro) return `@${miembro.displayName}`;
    return '@usuario';
  }
  return resultado;
}

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
        embeds: [
          successEmbed(
            `Frase del día configurada: se publica en ${canal} a las **${hora}:00** (hora de Argentina).\nAgregá frases con \`/frases agregar\`.`
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'agregar') {
      const texto = interaction.options.getString('texto', true).trim();
      const autorCrudo = interaction.options.getString('autor')?.trim() || interaction.user.username;
      const autor = await resolverAutor(interaction.guild, autorCrudo);
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
        return interaction.reply({
          embeds: [errorEmbed('No hay frases cargadas. Agregá la primera con `/frases agregar`.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      // Diferido antes de resolver el autor (puede hacer fetch) y de publicar.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const frase = frases[Math.floor(Math.random() * frases.length)];
      const autor = await resolverAutor(interaction.guild, frase.autor);
      const embed = infoEmbed(`> ${frase.texto}`, 'Frase del día');
      embed.setFooter({ text: `— ${autor} • TriggerBOT` });

      // Si el canal no acepta mensajes, hay que decirlo: antes se confirmaba la
      // publicación aunque Discord la hubiera rechazado.
      const enviado = await interaction.channel.send({ embeds: [embed] }).catch((e) => e);
      if (enviado instanceof Error) {
        return interaction.editReply({
          embeds: [errorEmbed(`No pude publicar la frase en este canal.\n> ${enviado.message}`)],
        });
      }
      return interaction.editReply({ embeds: [successEmbed('Frase publicada en este canal.')] });
    }

    if (sub === 'lista') {
      const frases = config.fraseDelDia?.frases ?? [];
      if (!frases.length) {
        return interaction.reply({ embeds: [warnEmbed('No hay frases cargadas todavía.', 'Frases del día')], flags: MessageFlags.Ephemeral });
      }
      const cuerpo = frases.map((f, i) => `**${i + 1}.** ${f.texto} — *${f.autor}*`).join('\n');
      return interaction.reply({
        embeds: [infoEmbed(cuerpo.slice(0, 4000), `Frases del día (${frases.length})`)],
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
