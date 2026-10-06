// /logs buscar — búsqueda con filtros en el registro de moderación (src/casos.js).
//
// /casos responde "¿qué pasó con este usuario?" y "¿qué es el caso #123?". Este comando
// responde la otra mitad de las preguntas del staff: "¿qué sanciones hubo esta semana?",
// "¿qué aplicó tal moderador?", "¿cuántos baneos hubo?". Comparte con /casos el formato
// de cada fila (quien/fecha) para que las dos vistas del registro no se desincronicen.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { listar, acciones: accionesDe } = require('../casos');
const { brandEmbed, errorEmbed, COLORS } = require('../utils/replies');
const { exigirStaff } = require('../utils/permisos');
const { parsearDuracion } = require('../utils/tempbans');
const { quien, fecha } = require('./casos');

const POR_PAGINA = 10; // igual que /casos: se lee cómodo y entra en un embed
const MAX_SUGERENCIAS = 25; // tope que acepta el autocompletado de Discord
const MAX_CHOICE = 100; // largo máximo del valor de una opción

function embedDeBusqueda(visibles, { total, pagina, paginas, filtros }) {
  const fields = visibles.map((caso) => ({
    name: `#${caso.numero} — ${caso.action}`.slice(0, 256),
    value:
      `${quien(caso)} · ${fecha(caso.timestamp)}\n` +
      `> ${String(caso.reason || 'No especificado').slice(0, 160)}\n` +
      `> aplicado por <@${caso.moderatorId}>`,
  }));

  return brandEmbed({
    color: COLORS.info,
    title: 'Registro de moderación',
    description:
      `**${total}** caso(s)` + (filtros.length ? ` · filtros: ${filtros.join(' · ')}` : ' · sin filtros (todo el registro)'),
    fields: fields.length ? fields : [{ name: 'Sin resultados', value: 'No hay casos que coincidan con la búsqueda.' }],
    footer:
      `TriggerBOT • ${paginas > 1 ? `página ${pagina}/${paginas} · ` : ''}` +
      'usá pagina:<n> para recorrer · /casos caso:<numero> para ver uno en detalle',
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Busca en el registro de moderación (mod-log) con filtros')
    .addSubcommand((sc) =>
      sc
        .setName('buscar')
        .setDescription('Busca casos por acción, usuario, moderador o antigüedad')
        .addStringOption((o) =>
          o
            .setName('accion')
            .setDescription('Parte del nombre de la acción (ej. ban, timeout, warn)')
            .setMaxLength(MAX_CHOICE)
            .setAutocomplete(true)
        )
        .addUserOption((o) => o.setName('usuario').setDescription('Casos de este usuario (el sancionado)'))
        .addUserOption((o) => o.setName('moderador').setDescription('Casos aplicados por este moderador'))
        .addStringOption((o) => o.setName('desde').setDescription('Cuánto atrás mirar: 24h, 7d, 30d (máx 30 días)').setMaxLength(6))
        .addIntegerOption((o) => o.setName('pagina').setDescription('Página de resultados (10 por página)').setMinValue(1))
    ),

  async autocomplete(interaction) {
    const escritas = accionesDe(interaction.guildId);
    const texto = String(interaction.options.getFocused() ?? '').toLowerCase();
    const opciones = [
      ...new Set(
        escritas
          .filter((accion) => accion.toLowerCase().includes(texto))
          .slice(0, MAX_SUGERENCIAS)
          .map((accion) => accion.slice(0, MAX_CHOICE))
      ),
    ].map((accion) => ({ name: accion, value: accion }));
    return interaction.respond(opciones);
  },

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ModerateMembers, 'El registro de moderación es solo para el staff.'))) return;

    const usuario = interaction.options.getUser('usuario');
    const moderador = interaction.options.getUser('moderador');
    const accionBuscada = (interaction.options.getString('accion') ?? '').trim();
    const desdeTexto = interaction.options.getString('desde');
    const paginaPedida = interaction.options.getInteger('pagina') ?? 1;

    // La antigüedad se valida con el mismo parser que /tempban (una sola definición de
    // "24h" o "7d" en todo el bot) y con su mismo rango: de 1 minuto a 30 días.
    let desde = null;
    if (desdeTexto) {
      const ms = parsearDuracion(desdeTexto);
      if (!ms) {
        return interaction.reply({
          embeds: [
            errorEmbed(
              `No pude interpretar **${desdeTexto}** como antigüedad.\nUsá por ejemplo \`24h\`, \`7d\` o \`30d\` (de 1 minuto a 30 días).`
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
      desde = Date.now() - ms;
    }

    const encontrados = listar(interaction.guildId, {
      usuarioId: usuario?.id ?? null,
      moderadorId: moderador?.id ?? null,
      accion: accionBuscada || null,
      desde,
    });

    const paginas = Math.max(1, Math.ceil(encontrados.length / POR_PAGINA));
    const pagina = Math.min(Math.max(paginaPedida, 1), paginas);
    const visibles = encontrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);

    const filtros = [
      accionBuscada ? `acción «${accionBuscada}»` : null,
      usuario ? `sancionado ${usuario}` : null,
      moderador ? `moderador ${moderador}` : null,
      desdeTexto ? `últimos ${desdeTexto}` : null,
    ].filter(Boolean);

    return interaction.reply({
      embeds: [embedDeBusqueda(visibles, { total: encontrados.length, pagina, paginas, filtros })],
      flags: MessageFlags.Ephemeral,
    });
  },
};
