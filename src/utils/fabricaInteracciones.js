// Fábrica de comandos de interacción: /beso, /abrazo, /caricia... como comandos
// directos (más simple para la comunidad que /interaccion beso). Genera un comando
// por acción a partir del catálogo de src/utils/interacciones.js.

const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { ACCIONES, traerGIF, contar, total } = require('./interacciones');
const { brandEmbed, errorEmbed, COLORS } = require('../utils/replies');

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
          embeds: [brandEmbed({ color: COLORS.warn, title: `${def.emoji} Auto-interacción`, description: AUTO_TEXTOS[accion] })],
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
      // traerGIF nunca lanza: devuelve null y el embed sale sin imagen.
      const gif = await traerGIF(def.endpoint).catch(() => null);

      const veces = contar(interaction.guildId, accion, interaction.user.id, receptor.id);
      const recibidas = total(interaction.guildId, accion, receptor.id);

      const embed = new EmbedBuilder()
        .setColor(def.emoji === '💥' ? COLORS.error : COLORS.carino)
        .setDescription(`**${interaction.member.displayName}** ${def.texto} **${receptor}** ${def.emoji}`)
        .setFooter({
          text: `Llevás ${veces} ${accion}${veces === 1 ? '' : 's'} a ${receptor.username} • recibió ${recibidas} en total`,
        });
      if (gif) embed.setImage(gif);

      // Si Discord rechaza el envío (permisos en el canal), se avisa en vez de
      // dejar el "pensando…" colgado para siempre.
      const enviado = await interaction.editReply({ embeds: [embed] }).catch((e) => e);
      if (enviado instanceof Error) {
        await interaction
          .followUp({ embeds: [errorEmbed(`No pude publicar la interacción.\n> ${enviado.message}`)], flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    },
  };
}

// Un comando por acción del catálogo.
const comandos = Object.entries(ACCIONES).map(([accion, def]) => crearComando(accion, def));

module.exports = { comandos };
