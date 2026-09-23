// /buscar — búsqueda web a mano, para el staff (efímera: solo la ve quien la usa).
//
// Por qué existe: el bot busca solo cuando le preguntan por mención, y el staff no tenía
// forma de ver QUÉ está leyendo. Este comando muestra los resultados crudos con su fuente
// y la decisión que tomaría el bot con esa pregunta (¿es de la comunidad? ¿buscaría antes
// de responder?). Sirve para auditar el sistema de búsqueda y para responder algo puntual
// al toque sin esperar a que la IA lo redacte.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { brandEmbed, warnEmbed, COLORS } = require('../utils/replies');
const web = require('../utils/web');
const { perfilDe } = require('../utils/ia');

const MAX_RESULTADOS = 5;
const MAX_TEXTO = 600; // el límite de un campo de embed es 1024: entran texto + link

function recortar(texto, limite) {
  const limpio = String(texto || '').trim();
  if (limpio.length <= limite) return limpio;
  return `${limpio.slice(0, limite).trimEnd()}…`;
}

// Cómo leería el bot esta consulta: es la parte que hace auditable el sistema.
function decision(consulta) {
  const perfil = perfilDe(consulta);
  const modo = web.clasificarConsulta(consulta, { perfil });
  const plan = web.decidirBusqueda(consulta, { perfil });
  const nombre = { comunidad: 'de la comunidad', general: 'de cultura general', charla: 'charla' }[modo];
  const cuando = !plan.buscar
    ? 'no buscaría (la base del server manda)'
    : plan.forzar
      ? 'buscaría ANTES de responder'
      : 'buscaría solo si la IA contesta que no sabe';
  return `El bot clasifica esto como **${nombre}** y ${cuando}.`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('buscar')
    .setDescription('Busca en internet y muestra los resultados crudos con su fuente (staff)')
    .addStringOption((o) =>
      o.setName('consulta').setDescription('Qué buscar, tal como lo preguntaría un usuario').setRequired(true).setMaxLength(200)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const consulta = interaction.options.getString('consulta', true).trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // `forzar` saltea el cooldown por usuario (es el staff probando a mano), no el tope
    // por minuto: ese protege a las fuentes.
    const resultados = await web.buscar(consulta, { forzar: true });
    const encabezado = decision(consulta);

    if (!resultados.length) {
      return interaction.editReply({
        embeds: [
          warnEmbed(
            `${encabezado}\n\nNo trajo **nada**: ni Wikipedia (es/en), ni DuckDuckGo, ni las fuentes especializadas.\n` +
              '> Probá con menos palabras o con el nombre propio solo (por ejemplo `Lionel Messi` en vez de la pregunta entera).\n' +
              '> Si estás probando muchas consultas seguidas, el bot frena a las 20 por minuto para no saturar las fuentes.',
            '🔎 Sin resultados'
          ),
        ],
      });
    }

    const campos = resultados.slice(0, MAX_RESULTADOS).map((r) => ({
      name: recortar(`[${r.fuente}] ${r.titulo || 'Sin título'}`, 250),
      value: recortar(r.texto, MAX_TEXTO) + (r.url ? `\n🔗 ${r.url}` : ''),
    }));

    const embed = brandEmbed({
      color: COLORS.info,
      title: `🔎 ${recortar(consulta, 200)}`,
      description: `${encabezado}\n**${resultados.length}** resultado(s), en el orden en que se le pasan a la IA.`,
      fields: campos,
      footer: 'TriggerBOT • /diag prueba si el host tiene salida a internet',
    });

    return interaction.editReply({ embeds: [embed] });
  },
};
