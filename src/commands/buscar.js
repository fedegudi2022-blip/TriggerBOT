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
const conocimiento = require('../utils/conocimiento');
const { perfilDe } = require('../utils/ia');
const { exigirStaff } = require('../utils/permisos');

const MAX_RESULTADOS = 5;
const MAX_TEXTO = 600; // el límite de un campo de embed es 1024: entran texto + link

function recortar(texto, limite) {
  const limpio = String(texto || '').trim();
  if (limpio.length <= limite) return limpio;
  return `${limpio.slice(0, limite).trimEnd()}…`;
}

// Cómo leería el bot esta consulta: es la parte que hace auditable el sistema.
// Replica la decisión real de la charla (utils/ia.js), incluida la base del server: una
// pregunta con palabras ambiguas es de la comunidad solo si el buscador la reconoce.
//
// La búsqueda es la MISMA que usa la charla (híbrida: palabras + semántica), así que lo
// que se ve acá es exactamente lo que la IA tendría delante. Sin clave de Gemini esto
// devuelve el resultado por palabras, igual que siempre.
async function decision(consulta) {
  const perfil = perfilDe(consulta);
  const fragmentos = await conocimiento.buscarHibrido(consulta);
  const hayConocimiento = fragmentos.some((f) => f.enTitulo);
  const modo = web.clasificarConsulta(consulta, { perfil, hayConocimiento });
  const plan = web.decidirBusqueda(consulta, { perfil, modo, hayConocimiento });
  const nombre = { comunidad: 'de la comunidad', general: 'de cultura general', charla: 'charla' }[modo];
  const cuando = !plan.buscar
    ? 'no buscaría (la base del server manda)'
    : plan.forzar
      ? 'buscaría ANTES de responder'
      : 'buscaría en paralelo, y usaría los resultados solo si la IA no sabe';
  return `El bot clasifica esto como **${nombre}** y ${cuando}.\n${detalleBase(fragmentos, hayConocimiento)}`;
}

// Qué sacó el buscador de la base del server y por qué señal. Es la parte que hace
// calibrable la semántica: los umbrales (KB_SEMANTICO_UMBRAL / KB_SEMANTICO_TITULO) se
// ajustan mirando acá los números reales de una consulta que el staff conoce.
function detalleBase(fragmentos, hayConocimiento) {
  if (!fragmentos.length) {
    return '> La base del server no trajo ningún fragmento: el bot responde con lo que sepa (y, si queda en negativa, busca en la web).';
  }

  const señales = { bm25: 'palabras', semantico: 'semántico', 'bm25+semantico': 'palabras + semántico' };
  const lista = fragmentos
    .map((f) => {
      const similitud = f.similitud == null ? '' : `, similitud ${f.similitud}`;
      return `\`${recortar(f.titulo, 60)}\` (${señales[f.origen] ?? f.origen}${similitud})`;
    })
    .join(' · ');
  const mejor = Math.max(...fragmentos.map((f) => f.similitud ?? 0));
  const { aceptar, titulo } = conocimiento.umbrales();

  return [
    `**${fragmentos.length}** fragmento(s) de la base: ${lista}`,
    hayConocimiento
      ? '> Cuenta como **tema cargado**: la base del server viaja al prompt de la IA.'
      : '> No cuenta como tema cargado: la IA responde sin la base del server.',
    mejor > 0
      ? `> Mejor similitud semántica: **${mejor}** · umbrales: ${aceptar} para aceptar una sección, ${titulo} para contar como tema cargado.`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  // Cada consulta golpea Wikipedia y DuckDuckGo: 5 s por usuario alcanzan para que
  // probar a mano siga siendo cómodo sin saturar las fuentes.
  cooldown: 5,
  data: new SlashCommandBuilder()
    .setName('buscar')
    .setDescription('Busca en internet y muestra los resultados crudos con su fuente (staff)')
    .addStringOption((o) =>
      o.setName('consulta').setDescription('Qué buscar, tal como lo preguntaría un usuario').setRequired(true).setMaxLength(200)
    ),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ManageGuild))) return;

    const consulta = interaction.options.getString('consulta', true).trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // `forzar` saltea el cooldown por usuario (es el staff probando a mano), no el tope
    // por minuto: ese protege a las fuentes.
    const resultados = await web.buscar(consulta, { forzar: true });
    const encabezado = await decision(consulta);

    if (!resultados.length) {
      return interaction.editReply({
        embeds: [
          warnEmbed(
            `${encabezado}\n\nNo trajo **nada**: ni Wikipedia (es/en), ni DuckDuckGo, ni las fuentes especializadas.\n` +
              '> Probá con menos palabras o con el nombre propio solo (por ejemplo `Lionel Messi` en vez de la pregunta entera).\n' +
              '> Si estás probando muchas consultas seguidas, el bot frena a las 30 por minuto para no saturar las fuentes.',
            'Sin resultados'
          ),
        ],
      });
    }

    const campos = resultados.slice(0, MAX_RESULTADOS).map((r) => ({
      name: recortar(`[${r.fuente}] ${r.titulo || 'Sin título'}`, 250),
      value: recortar(r.texto, MAX_TEXTO) + (r.url ? `\n${r.url}` : ''),
    }));

    const embed = brandEmbed({
      color: COLORS.info,
      title: `${recortar(consulta, 200)}`,
      description: `${encabezado}\n**${resultados.length}** resultado(s), en el orden en que se le pasan a la IA.`,
      fields: campos,
      footer: 'TriggerBOT • /diag prueba si el host tiene salida a internet',
    });

    return interaction.editReply({ embeds: [embed] });
  },
};
