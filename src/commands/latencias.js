// /latencias — cuánto tardan de verdad las respuestas del bot, por perfil (staff).
//
// Por qué existe: /status mide a cada PROVEEDOR (Groq, Gemini, Cerebras…) y responde
// "¿quién va rápido?", pero no la pregunta que el staff se hace cuando alguien se queja:
// "¿qué tipo de pregunta tarda más y por qué?". Este comando muestra las tres cosas juntas:
//
//   1. Por perfil (charla / consulta / profundo): mediana, peor 5 % y de qué camino salió
//      cada respuesta (IA, caché, cálculo o repertorio local).
//   2. Por causa: cuánto cuesta una búsqueda antes de responder, un rescate con web (2+
//      generaciones) o un turno sin IA, comparado con el camino normal.
//   3. Las preguntas más lentas, con su texto: la muestra concreta que hay que mirar.
//
// Los datos los junta utils/rendimiento.js en cada turno de `conversar()`; son en memoria
// y describen el uso desde el arranque del bot (igual que los contadores de /status).
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { brandEmbed, COLORS, marcaTiempo } = require('../utils/replies');
const rendimiento = require('../utils/rendimiento');
const { exigirStaff } = require('../utils/permisos');

const fmt = rendimiento.formatoDeMs;

// Una línea por camino: qué la resolvió y cuántas veces.
function caminosTexto(caminos) {
  return [
    caminos.ia ? `IA ${caminos.ia}` : null,
    caminos.cache ? `caché ${caminos.cache}` : null,
    caminos.calculo ? `cálculo ${caminos.calculo}` : null,
    caminos.local ? `sin IA ${caminos.local}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function valorPerfil(p) {
  const caminos = caminosTexto(p.caminos);
  return (
    `**${fmt(p.p50)}** de mediana · ${fmt(p.p95)} en el peor 5 %\n` +
    `${p.n} respuesta(s) · la más lenta ${fmt(p.max)}` +
    (caminos ? `\n${caminos}` : '')
  );
}

function valorCausas(causas) {
  return causas.map((c) => `• ${c.etiqueta}: **${c.n}** respuesta(s), mediana ${fmt(c.p50)}`).join('\n');
}

// Las más lentas: la duración, el perfil, POR QUÉ tardó y la pregunta concreta.
function valorLentas(lentas) {
  return lentas
    .map((m) => `**${fmt(m.ms)}** · ${m.perfil} · ${rendimiento.causaDe(m)} · ${marcaTiempo(m.cuando)}\n> ${m.pregunta ? `"${m.pregunta}"` : '(sin texto)'}`)
    .join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('latencias')
    .setDescription('Latencia real de las respuestas por perfil, con la causa de cada demora (staff)'),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ManageGuild))) return;

    const r = rendimiento.resumen();
    if (!r.total) {
      return interaction.reply({
        embeds: [
          brandEmbed({
            color: COLORS.gris,
            title: 'Latencia por perfil',
            description:
              'Todavía no hay respuestas medidas en este arranque.\n\n' +
              'Se miden solas: cada vez que alguien menciona al bot, la respuesta deja su perfil (charla, consulta o profundo), ' +
              'cuánto tardó y qué la demoró. Escribí algo mencionando al bot y volvé a correr el comando.',
            footer: `TriggerBOT • ventana de las últimas ${rendimiento.MAX_MUESTRAS} respuestas, desde el arranque`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = brandEmbed({
      color: COLORS.info,
      title: 'Latencia real de las respuestas, por perfil',
      description:
        `Medido en **${r.total}** respuesta(s), desde ${marcaTiempo(r.desde)}.\n` +
        'Cada perfil usa un modelo y un molde distintos, así que compararlos entre sí dice poco; lo que importa es **por qué** tarda cada uno.',
      fields: [
        ...r.perfiles.map((p) => ({ name: `${p.etiqueta} (${p.n})`, value: valorPerfil(p), inline: false })),
        { name: '¿Por qué tardan?', value: valorCausas(r.causas), inline: false },
        { name: `Las más lentas (${r.lentas.length})`, value: valorLentas(r.lentas).slice(0, 1024), inline: false },
      ],
      footer: `TriggerBOT • en memoria, desde el arranque • /status lo muestra compacto`,
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
