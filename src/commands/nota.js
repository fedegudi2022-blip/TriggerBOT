// /nota — notas internas del staff sobre un usuario.
//
// Se guardan aparte de los warns a propósito: una nota es una observación
// ("habló con el staff", "ya se le avisó") que NO cuenta para el silencio
// automático de 3 advertencias. Si vivieran en el historial de warns, una
// observación terminaría sancionando.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getNotas, addNota, removeNota } = require('../notas');
const { nombreDe, brandEmbed, COLORS } = require('../utils/replies');
const { exigirStaff } = require('../utils/permisos');

const fecha = (ts) => `<t:${Math.floor(ts / 1000)}:d>`;

// Paginación: 50 notas de 500 caracteres son 25.000, y la descripción de un embed
// corta a 4096. Antes se recortaba con slice(0, 4000), así que las últimas notas eran
// invisibles sin que nadie se enterara. Ahora se pagina de a 5 y cada campo se corta
// antes del límite de 1024 (mismo criterio que /warnings).
const POR_PAGINA = 5;
const MAX_CARACTERES_CAMPO = 1000;

function vista(usuario, notas, paginaPedida = 1) {
  if (!notas.length) {
    return brandEmbed({
      color: COLORS.success,
      title: `Notas de ${nombreDe(usuario)}`,
      description: 'Sin notas internas.',
      thumbnail: usuario.displayAvatarURL?.({ size: 128 }),
    });
  }

  const entradas = notas.map((n, i) => {
    const texto = String(n.texto ?? '');
    return {
      numero: i + 1,
      linea: `**#${i + 1}** — ${fecha(n.timestamp)} por <@${n.moderatorId}>\n> ${texto.slice(0, 500)}${texto.length > 500 ? '…' : ''}`,
    };
  });

  // El número de cada nota es su posición original: es el que pide /nota quitar.
  const paginas = Math.max(1, Math.ceil(entradas.length / POR_PAGINA));
  const pagina = Math.min(Math.max(Number(paginaPedida) || 1, 1), paginas);
  const visibles = entradas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);

  const fields = [];
  let buffer = '';
  for (const entrada of visibles) {
    const candidato = buffer ? `${buffer}\n\n${entrada.linea}` : entrada.linea;
    if (candidato.length > MAX_CARACTERES_CAMPO) {
      fields.push({ name: fields.length === 0 ? tituloDePagina(pagina, paginas) : '\u200b', value: buffer, inline: false });
      buffer = entrada.linea;
    } else {
      buffer = candidato;
    }
  }
  if (buffer) fields.push({ name: fields.length === 0 ? tituloDePagina(pagina, paginas) : '\u200b', value: buffer, inline: false });

  return brandEmbed({
    color: COLORS.info,
    title: `Notas de ${nombreDe(usuario)} (${notas.length})`,
    fields,
    thumbnail: usuario.displayAvatarURL?.({ size: 128 }),
    footer:
      'TriggerBOT • las notas NO cuentan como advertencias • /nota quitar para borrar' +
      (paginas > 1 ? ` • página ${pagina}/${paginas}` : ''),
  });
}

const tituloDePagina = (pagina, paginas) => (paginas > 1 ? `Página ${pagina}/${paginas}` : 'Notas');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nota')
    .setDescription('Notas internas sobre un usuario (no cuentan como advertencias)')
    .addSubcommand((sc) =>
      sc
        .setName('agregar')
        .setDescription('Agrega una nota interna')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario al que se refiere la nota').setRequired(true))
        .addStringOption((o) => o.setName('texto').setDescription('Contenido de la nota').setRequired(true).setMaxLength(500))
    )
    .addSubcommand((sc) =>
      sc
        .setName('ver')
        .setDescription('Muestra las notas de un usuario')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('pagina').setDescription('Página de la lista (5 notas por página)').setMinValue(1)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('quitar')
        .setDescription('Elimina una nota por su número')
        .addUserOption((o) => o.setName('usuario').setDescription('Dueño de la nota').setRequired(true))
        .addIntegerOption((o) => o.setName('numero').setDescription('Número de la nota (empezando en 1)').setRequired(true).setMinValue(1))
    ),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ModerateMembers, 'Las notas internas son solo para el staff.'))) return;

    const sub = interaction.options.getSubcommand();
    const usuario = interaction.options.getUser('usuario', true);
    const guildId = interaction.guildId;

    if (sub === 'agregar') {
      const texto = interaction.options.getString('texto', true).trim();
      addNota(guildId, usuario.id, { texto, moderatorId: interaction.user.id, timestamp: Date.now() });
      const total = getNotas(guildId, usuario.id).length;
      return interaction.reply({
        embeds: [
          brandEmbed({
            color: COLORS.success,
            title: 'Nota guardada',
            description: `Anoté algo sobre ${usuario} (${total} nota(s) en total). **No cuenta como advertencia.**`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'ver') {
      const pagina = interaction.options.getInteger('pagina') ?? 1;
      return interaction.reply({ embeds: [vista(usuario, getNotas(guildId, usuario.id), pagina)], flags: MessageFlags.Ephemeral });
    }

    // quitar
    const numero = interaction.options.getInteger('numero', true);
    const quitada = removeNota(guildId, usuario.id, numero);
    if (!quitada) {
      return interaction.reply({
        embeds: [brandEmbed({ color: COLORS.warn, title: 'No encontré esa nota', description: `${usuario} no tiene una nota #${numero}.` })],
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      embeds: [brandEmbed({ color: COLORS.success, title: 'Nota eliminada', description: `Borré la nota #${numero} de ${usuario}.` })],
      flags: MessageFlags.Ephemeral,
    });
  },
};
