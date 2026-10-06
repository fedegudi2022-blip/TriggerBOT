// /casos — consulta el registro persistente de moderación (src/casos.js).
//
// El mod-log guarda cada caso como un embed en el canal, pero eso se pierde con el
// scroll. Este comando busca un caso puntual por número o el historial de un usuario,
// que es lo que el staff necesita para revisar una sanción.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { obtener, listar } = require('../casos');
const { nombreDe, brandEmbed, COLORS } = require('../utils/replies');
const { exigirStaff } = require('../utils/permisos');

const MAX_LISTA = 10; // casos por consulta (un embed aguanta 25 campos; 10 se lee cómodo)

const fecha = (ts) => `<t:${Math.floor(ts / 1000)}:f>`;

function quien(caso) {
  if (caso.targetId) return `<@${caso.targetId}>${caso.targetTag ? ` (\`${caso.targetTag}\`)` : ''}`;
  return caso.targetRaw ? `\`${caso.targetRaw.replaceAll('`', '')}\`` : '—';
}

// Detalle de un caso puntual.
function embedDeCaso(caso) {
  const fields = [
    { name: 'Usuario', value: quien(caso), inline: true },
    { name: 'Moderador', value: `<@${caso.moderatorId}>`, inline: true },
    { name: 'Fecha', value: fecha(caso.timestamp), inline: true },
    { name: 'Motivo', value: caso.reason || '*No especificado*', inline: false },
  ];
  if (caso.duration) fields.push({ name: 'Duración', value: caso.duration, inline: true });
  if (caso.extra) fields.push({ name: 'Detalles', value: String(caso.extra).slice(0, 1000), inline: false });

  return brandEmbed({
    color: caso.color ?? COLORS.info,
    title: `Caso #${caso.numero} — ${caso.action}`,
    fields,
    footer: 'TriggerBOT • registro de moderación',
  });
}

// Lista de casos (del más nuevo al más viejo).
function embedDeLista(casos, { usuario, total }) {
  const fields = casos.map((caso) => ({
    name: `#${caso.numero} — ${caso.action}`,
    value: `${quien(caso)} · ${fecha(caso.timestamp)}\n> ${String(caso.reason || 'No especificado').slice(0, 200)}`,
  }));
  return brandEmbed({
    color: COLORS.info,
    title: usuario ? `Casos de ${nombreDe(usuario)}` : 'Últimos casos de moderación',
    description: total > casos.length ? `Mostrando los **${casos.length}** más recientes de **${total}**.` : `**${total}** caso(s).`,
    fields: fields.length
      ? fields
      : [{ name: 'Sin resultados', value: usuario ? 'Ese usuario no tiene casos registrados.' : 'Todavía no hay casos.' }],
    footer: 'TriggerBOT • usá /casos caso:<numero> para ver uno en detalle',
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('casos')
    .setDescription('Consulta el registro de casos de moderación (mod-log)')
    .addIntegerOption((o) => o.setName('caso').setDescription('Número de caso a ver en detalle').setMinValue(1))
    .addUserOption((o) => o.setName('usuario').setDescription('Ver todos los casos de este usuario')),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ModerateMembers, 'El registro de casos es solo para el staff.'))) return;

    const numero = interaction.options.getInteger('caso');
    const usuario = interaction.options.getUser('usuario');
    const guildId = interaction.guildId;
    let embed;

    if (numero) {
      const caso = obtener(guildId, numero);
      if (!caso) {
        return interaction.reply({
          embeds: [
            brandEmbed({
              color: COLORS.warn,
              title: `Caso #${numero}`,
              description: 'No encontré ese caso. Puede ser más viejo que el registro guardado.',
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
      embed = embedDeCaso(caso);
    } else {
      const total = listar(guildId, { usuarioId: usuario?.id ?? null }).length;
      const casos = listar(guildId, { usuarioId: usuario?.id ?? null, limite: MAX_LISTA });
      embed = embedDeLista(casos, { usuario, total });
    }

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },

  // El formato de cada fila lo comparten /casos y /logs: si cambia el criterio para
  // nombrar al sancionado o para mostrar la fecha, cambia en los dos a la vez.
  quien,
  fecha,
};
