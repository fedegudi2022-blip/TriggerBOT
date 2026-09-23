// /warnings — historial de advertencias de un usuario, con severidad visual,
// paginación y botones.
//
// Antes metía TODO el historial en un solo campo del embed (`value: lista.slice(0, 4000)`):
// un campo de embed tiene un límite de 1024 caracteres, así que con ~12 advertencias
// Discord rechazaba el mensaje entero y el staff no veía nada. Ahora se pagina de a 8
// y cada campo se corta antes del límite.
//
// Severidad: 🟢 historial limpio · 🟡 con advertencias · 🔴 al límite (3 = silencio de 1 h).
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getWarns } = require('../warns');
const { getGuildConfig } = require('../store');
const { brandEmbed, COLORS } = require('../utils/replies');

const LIMITE_WARNS = 3; // mismo umbral que /warn (silencio automático de 1 h al tercer warn)
const POR_PAGINA = 8;
const MAX_CARACTERES_CAMPO = 1000; // el límite real de Discord por campo es 1024

function esStaff(interaction) {
  if (interaction.member?.permissions?.has?.(PermissionFlagsBits.ModerateMembers)) return true;
  const config = getGuildConfig(interaction.guildId);
  return ['admin', 'mod', 'helper'].some((nivel) => interaction.member?.roles?.cache?.has?.(config[`${nivel}Role`]));
}

// Arma el embed y los botones de una página del historial.
function vista(interaction, user, paginaPedida) {
  const warns = getWarns(interaction.guild.id, user.id);
  if (!warns.length) {
    return {
      embeds: [
        brandEmbed({
          color: COLORS.success,
          title: '📋 Historial limpio',
          description: `${user} no tiene advertencias registradas. ✨`,
          thumbnail: user.displayAvatarURL({ size: 128 }),
          footer: `TriggerBOT • ${LIMITE_WARNS} advertencias acumuladas = silencio automático de 1 h`,
        }),
      ],
      components: [],
    };
  }

  // Del más nuevo al más viejo (el número es la posición original en el historial,
  // que es la que pide /quitarnota).
  const entradas = warns
    .map((w, i) => ({
      numero: i + 1,
      linea: `**#${i + 1}** — <t:${Math.floor(w.timestamp / 1000)}:f> por <@${w.moderatorId}>\n> ${w.reason}`,
    }))
    .reverse();

  const paginas = Math.max(1, Math.ceil(entradas.length / POR_PAGINA));
  const pagina = Math.min(Math.max(paginaPedida, 1), paginas);
  const visibles = entradas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);

  // Campos de a ≤1000 caracteres (varias advertencias por campo).
  const campos = [];
  let buffer = '';
  for (const entrada of visibles) {
    const candidato = buffer ? `${buffer}\n\n${entrada.linea}` : entrada.linea;
    if (candidato.length > MAX_CARACTERES_CAMPO) {
      campos.push({ name: campos.length === 0 ? `Historial (${pagina}/${paginas})` : '\u200b', value: buffer, inline: false });
      buffer = entrada.linea;
    } else {
      buffer = candidato;
    }
  }
  if (buffer) campos.push({ name: campos.length === 0 ? `Historial (${pagina}/${paginas})` : '\u200b', value: buffer, inline: false });

  const restantes = Math.max(LIMITE_WARNS - warns.length, 0);
  const alLimite = warns.length >= LIMITE_WARNS;

  const embed = brandEmbed({
    color: alLimite ? COLORS.error : COLORS.warn,
    title: `📋 Advertencias de ${user.tag}`,
    description:
      `**${warns.length}** advertencia(s) en total · ` +
      (alLimite ? 'ya alcanzó (o superó) el límite de silencio automático' : `**${restantes}** más y queda silenciado 1 h automáticamente`),
    thumbnail: user.displayAvatarURL({ size: 128 }),
    fields: campos,
    footer: `TriggerBOT • página ${pagina}/${paginas} • ${warns.length} en total • /quitarnota numero para eliminar una`,
  });

  const componentes = [];
  if (paginas > 1) {
    componentes.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`warnings:${user.id}:${pagina - 1}`)
          .setLabel('Anterior')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pagina <= 1),
        new ButtonBuilder()
          .setCustomId(`warnings:${user.id}:${pagina + 1}`)
          .setLabel('Siguiente')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pagina >= paginas)
      )
    );
  }

  return { embeds: [embed], components: componentes };
}

// Lo usan el slash y los botones de página (misma vista, mismo permiso).
async function ejecutar(interaction, user, pagina = 1) {
  if (!esStaff(interaction)) {
    return interaction.reply({
      embeds: [brandEmbed({ color: COLORS.error, title: 'Solo staff', description: 'El historial de advertencias es solo para el staff.' })],
      flags: MessageFlags.Ephemeral,
    });
  }

  const vista_ = vista(interaction, user, pagina);
  if (interaction.isButton?.()) return interaction.update(vista_);
  return interaction.reply({ ...vista_, flags: MessageFlags.Ephemeral });
}

module.exports = {
  ejecutar,

  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Muestra el historial de advertencias de un usuario')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar').setRequired(true)),

  async execute(interaction) {
    return ejecutar(interaction, interaction.options.getUser('usuario', true), 1);
  },
};
