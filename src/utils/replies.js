const { EmbedBuilder } = require('discord.js');

// Estilo visual unificado de TriggerBOT: colores por tipo de mensaje + footer de marca.
const COLORS = {
  success: 0x57f287,
  error: 0xed4245,
  info: 0x5865f2,
  warn: 0xfee75c,
};

function brandEmbed({ color = COLORS.info, title, description, fields, footer }) {
  const embed = new EmbedBuilder().setColor(color).setTimestamp().setFooter({ text: footer || 'TriggerBOT' });
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (fields?.length) embed.addFields(fields);
  return embed;
}

const successEmbed = (description, title = 'Acción completada') =>
  brandEmbed({ color: COLORS.success, title, description });

const errorEmbed = (description, title = 'No se pudo completar') =>
  brandEmbed({ color: COLORS.error, title, description });

const warnEmbed = (description, title = 'Atención') =>
  brandEmbed({ color: COLORS.warn, title, description });

const infoEmbed = (description, title) =>
  brandEmbed({ color: COLORS.info, title, description });

module.exports = { COLORS, brandEmbed, successEmbed, errorEmbed, warnEmbed, infoEmbed };
