// Fábrica de comandos de interacción: /beso, /abrazo, /caricia... como comandos
// directos (más simple para la comunidad que /interaccion beso). Genera un comando
// por acción a partir del catálogo de src/utils/interacciones.js.

const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { ACCIONES, traerGIF, contar, total } = require('./interacciones');
const { brandEmbed, errorEmbed } = require('../utils/replies');

// Textos de auto-interacción (te beso a vos mismo).
const AUTO_TEXTOS = {
  beso: 'Te diste un beso en el espejo. Confianza ante todo.',
  abrazo: 'Te abrazaste a vos mismo. Lo intentamos.',
  caricia: 'Te acariciaste la cabeza. Está bien quererse.',
  abofetear: 'Te abofeteaste a vos mismo. ¿Todo bien?',
  morder: 'Te mordiste. Raro, pero ok.',
  pellizco: 'Te pellizcaste. ¿Sueño o realidad?',
  chocar: 'Chocaste los cinco con vos. ¡Buen trabajo, crack!',
  guino: 'Te guiñaste el ojo. Nivel máximo de confianza.',
};

// Genera el módulo de comando para una acción (ej: beso → /beso).
function crearComando(accion, def) {
  return {
    data: new SlashCommandBuilder()
      .setName(accion)
      .setDescription(def.desc)
      .addUserOption((o) => o.setName('usuario').setDescription('Receptor').setRequired(true)),

    async execute(interaction) {
      const receptor = interaction.options.getUser('usuario', true);

      if (receptor.id === interaction.user.id) {
        return interaction.reply({
          embeds: [brandEmbed({ color: 0xfee75c, title: `${def.emoji} Auto-interacción`, description: AUTO_TEXTOS[accion] })],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (receptor.bot) {
        return interaction.reply({
          embeds: [errorEmbed('Los bots no participamos de estas cosas... bueno, quizá un abrazo no vendría mal.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();

      // GIF con doble fuente (nekos.best → otakugifs); si ambas fallan, texto simple.
      const gif = await traerGIF(def.endpoint);

      const veces = contar(interaction.guildId, accion, interaction.user.id, receptor.id);
      const recibidas = total(interaction.guildId, accion, receptor.id);

      const embed = new EmbedBuilder()
        .setColor(def.emoji === '💥' ? 0xed4245 : 0xe91e63)
        .setDescription(`**${interaction.member.displayName}** ${def.texto} **${receptor}** ${def.emoji}`)
        .setFooter({
          text: `Llevás ${veces} ${accion}${veces === 1 ? '' : 's'} a ${receptor.username} • recibió ${recibidas} en total`,
        });
      if (gif) embed.setImage(gif);

      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    },
  };
}

// Un comando por acción del catálogo.
const comandos = Object.entries(ACCIONES).map(([accion, def]) => crearComando(accion, def));

module.exports = { comandos };
