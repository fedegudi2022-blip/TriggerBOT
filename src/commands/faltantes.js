// /faltantes — los temas que la gente preguntó y el bot no supo contestar (staff).
//
// Por qué existe: la negativa de la IA se perdía en el canal. Ahora utils/faltantes.js
// registra cada una agrupada por pregunta, y este comando es la lista de trabajo de la
// base de conocimiento: qué se pregunta, cuántas veces, quién y cuándo.
//
// El flujo es cargar y borrar: se escribe la respuesta en `docs/conocimiento/*.md` (el
// bot la recarga solo, sin reiniciar) y el tema se saca de la lista con
// `/faltantes borrar`. Los números que muestra `ver` son exactamente los que acepta
// `borrar`: el puesto en ESA lista, no el orden en que se registraron.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { brandEmbed, successEmbed, warnEmbed, errorEmbed, COLORS, marcaTiempo } = require('../utils/replies');
const faltantes = require('../utils/faltantes');
const { exigirStaff } = require('../utils/permisos');

const MAX_LISTA = 20; // con 20 líneas de dos renglones el embed sigue entrando en 4.096 caracteres
const POR_DEFECTO = 12;
const MODOS = { comunidad: 'comunidad', general: 'cultura general', charla: 'charla' };

function recorte(texto, limite = 90) {
  const limpio = String(texto ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length <= limite ? limpio : `${limpio.slice(0, limite - 1).trimEnd()}…`;
}

function vecesTexto(n) {
  return `${n} ${n === 1 ? 'vez' : 'veces'}`;
}

// Una línea por tema: el puesto (el que usa `borrar`), la pregunta, las veces y la última
// vez; debajo, el modo y quién la preguntó, que es lo que dice dónde buscar la respuesta.
function lineaTema(tema, puesto) {
  const modo = MODOS[tema.modo] ?? null;
  const contexto = [modo, tema.canal ? `#${tema.canal}` : null].filter(Boolean).join(' · ');
  const autores = tema.autores?.length ? `la preguntó ${tema.autores.map((a) => `**${a}**`).join(', ')}` : null;
  const detalle = [contexto, autores].filter(Boolean).join(' · ');
  return (
    `**${puesto}.** ${recorte(tema.pregunta)} — ${vecesTexto(tema.veces)} · última ${marcaTiempo(tema.ultima)}` +
    (detalle ? `\n> ${detalle}` : '')
  );
}

const PISTA = [
  '**Los de comunidad** se cargan en `docs/conocimiento/*.md` (una sección `## Título` con la palabra clave del tema) y después se borran con `/faltantes borrar`.',
  '**Los de cultura general** significan que la búsqueda web tampoco trajo nada: revisá la salida a internet del host con `/diag`.',
].join('\n');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('faltantes')
    .setDescription('Preguntas que el bot no supo contestar: qué cargar en la base (staff)')
    .addSubcommand((sc) =>
      sc
        .setName('ver')
        .setDescription('Muestra los temas sin respuesta, los más preguntados primero')
        .addIntegerOption((o) =>
          o.setName('cantidad').setDescription(`Cuántos mostrar (1-${MAX_LISTA}; por defecto ${POR_DEFECTO})`).setMinValue(1).setMaxValue(MAX_LISTA)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('borrar')
        .setDescription('Saca un tema de la lista (después de cargarlo en la base)')
        .addIntegerOption((o) =>
          o.setName('numero').setDescription('El número que muestra /faltantes ver').setRequired(true).setMinValue(1).setMaxValue(60)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('limpiar')
        .setDescription('Vacía el registro de temas sin respuesta')
        .addBooleanOption((o) => o.setName('confirmar').setDescription('Confirmá que querés perder la lista').setRequired(true))
    ),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ManageGuild))) return;

    const guildId = interaction.guildId ?? interaction.guild?.id;
    const sub = interaction.options.getSubcommand();

    if (sub === 'borrar') {
      const numero = interaction.options.getInteger('numero', true);
      const quitado = faltantes.olvidar(guildId, numero);
      if (!quitado) {
        return interaction.reply({
          embeds: [errorEmbed(`No hay ningún tema en el puesto **${numero}**. Mirá la lista con \`/faltantes ver\`.`)],
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        embeds: [successEmbed(`Saqué de la lista: **${recorte(quitado.pregunta, 120)}** (${vecesTexto(quitado.veces)}).`, 'Tema borrado')],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'limpiar') {
      if (!interaction.options.getBoolean('confirmar')) {
        return interaction.reply({
          embeds: [
            warnEmbed(
              'No vacié nada. Si es a propósito, usá `/faltantes limpiar confirmar:true`: los temas que todavía falten cargar se pierden.',
              'Falta confirmar'
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
      const cuantos = faltantes.limpiar(guildId);
      return interaction.reply({
        embeds: [successEmbed(cuantos ? `Registro vaciado: **${cuantos}** tema(s).` : 'El registro ya estaba vacío.', 'Lista limpia')],
        flags: MessageFlags.Ephemeral,
      });
    }

    // sub === 'ver'
    const cantidad = interaction.options.getInteger('cantidad') ?? POR_DEFECTO;
    const total = faltantes.total(guildId);
    const temas = faltantes.listar(guildId, { limite: cantidad });

    if (!temas.length) {
      return interaction.reply({
        embeds: [
          brandEmbed({
            color: COLORS.gris,
            title: 'Temas sin respuesta',
            description:
              'No hay ninguno registrado en este servidor.\n\n' +
              'La lista se llena **sola**: cada vez que la IA contesta que no sabe algo y ni la base del server ni la búsqueda web lo cubren, ' +
              'la pregunta queda acá para que el staff la cargue en `docs/conocimiento/*.md`.',
            footer: 'TriggerBOT • se ve con /faltantes ver y se limpia con /faltantes limpiar',
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = brandEmbed({
      color: total > temas.length ? COLORS.warn : COLORS.info,
      title: `Temas sin respuesta (${temas.length} de ${total})`,
      description: temas.map((tema, i) => lineaTema(tema, i + 1)).join('\n').slice(0, 4000),
      fields: [{ name: 'Cómo se saca de la lista', value: PISTA }],
      footer: 'TriggerBOT • se llenan solos con cada negativa de la IA',
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
