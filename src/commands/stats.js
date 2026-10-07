// /stats — canales de estadísticas del servidor (miembros, en línea, roles…).
// El staff los activa una vez y el bot mantiene los números al día solo.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { brandEmbed, successEmbed, errorEmbed, COLORS, marcaTiempo, miles } = require('../utils/replies');
const { exigirStaff } = require('../utils/permisos');
const stats = require('../utils/estadisticasServer');
const censo = require('../utils/censo');

// Cómo se escribe el catálogo en los textos: «`miembros` (👥 Miembros: total…)».
function catalogo() {
  return stats.METRICAS.map((m) => `\`${m.id}\` — ${m.emoji} ${m.etiqueta}: ${m.descripcion}`).join('\n');
}

// Línea de un canal: nombre configurado, valor medido y estado real.
function lineaCanal(guild, id) {
  const canal = guild.channels.cache.get(stats.canalIdDe(guild.id, id));
  const valor = stats.valorDeMetrica(guild, id);
  const medida = Number.isFinite(valor) ? miles(valor) : stats.SIN_DATO;
  const nombre = stats.nombreDeMetrica(id, valor);
  if (!canal) return `• **${id}** — canal borrado (se recrea con \`/stats metricas\`) · objetivo: \`${nombre}\``;
  return `• <#${canal.id}> — **${medida}** · se renombra a \`${nombre}\``;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Canales de estadísticas del server: miembros, en línea, roles… (solo staff)')
    .addSubcommand((sc) =>
      sc
        .setName('activar')
        .setDescription('Crea los canales de estadísticas y los mantiene actualizados')
        .addChannelOption((o) => o.setName('categoria').setDescription('Categoría donde ponerlos (vacío = una nueva)'))
        .addStringOption((o) =>
          o.setName('metricas').setDescription('Cuáles mostrar, separadas por comas. Ej: miembros,enLinea,roles (vacío = las tres por defecto)')
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('metricas')
        .setDescription('Cambia qué se muestra (crea y borra los canales que hagan falta)')
        .addStringOption((o) => o.setName('lista').setDescription('Ej: humanos,enLinea,roles,boosts').setRequired(true))
    )
    .addSubcommand((sc) => sc.setName('refrescar').setDescription('Actualiza los números ahora'))
    .addSubcommand((sc) => sc.setName('estado').setDescription('Muestra la configuración, los valores y el diagnóstico'))
    .addSubcommand((sc) =>
      sc
        .setName('desactivar')
        .setDescription('Apaga el sistema y borra los canales (podés conservarlos)')
        .addBooleanOption((o) => o.setName('borrar').setDescription('Borrar los canales creados (por defecto sí)'))
    ),

  cooldown: 5,

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ManageChannels))) return;

    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();

    if (sub === 'activar') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const categoria = interaction.options.getChannel('categoria');
      const resultado = await stats.activar(guild, { categoriaId: categoria?.id ?? null, metricas: interaction.options.getString('metricas') });
      if (!resultado.ok) return interaction.editReply({ embeds: [errorEmbed(resultado.error)] });

      const lineas = [
        `Canales activos: ${resultado.ids.map((id) => `\`${id}\``).join(' · ')} en **${resultado.categoria?.name ?? 'sin categoría'}**.`,
      ];
      if (resultado.creados.length) lineas.push(`Creados: ${resultado.creados.map((c) => `<#${c.canal.id}>`).join(' · ')}`);
      if (resultado.borrados.length) lineas.push(`Se quitaron: ${resultado.borrados.map((b) => `\`${b.id}\``).join(' · ')}`);
      if (resultado.fallidos.length) {
        lineas.push(`⚠️ **${resultado.fallidos.length} fallaron**: ${resultado.fallidos.map((f) => `\`${f.id}\` (${f.motivo})`).join(' · ')}`);
      }
      lineas.push(
        '',
        'Los números se revisan cada 10 minutos. Pocos: Discord solo permite **2 renombres por canal cada 10 minutos**, ' +
          'así que un cambio justo después de otro queda agendado y se aplica cuando se libera el cupo.',
        'Los canales son de solo lectura (nadie puede entrar a hablar). `/stats estado` muestra el detalle y `/stats metricas` cambia qué se muestra.'
      );
      return interaction.editReply({ embeds: [successEmbed(lineas.join('\n'))] });
    }

    if (sub === 'metricas') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const resultado = await stats.cambiarMetricas(guild, interaction.options.getString('lista', true));
      if (!resultado.ok) return interaction.editReply({ embeds: [errorEmbed(resultado.error)] });

      const lineas = [`Ahora se muestran: ${resultado.ids.map((id) => `\`${id}\``).join(' · ')}`];
      if (resultado.creados.length) lineas.push(`Creados: ${resultado.creados.map((c) => `<#${c.canal.id}>`).join(' · ')}`);
      if (resultado.borrados.length) lineas.push(`Borrados: ${resultado.borrados.map((b) => `\`${b.id}\``).join(' · ')}`);
      if (resultado.fallidos.length)
        lineas.push(`⚠️ **${resultado.fallidos.length} fallaron**: ${resultado.fallidos.map((f) => `\`${f.id}\` (${f.motivo})`).join(' · ')}`);
      return interaction.editReply({ embeds: [successEmbed(lineas.join('\n'))] });
    }

    if (sub === 'refrescar') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!stats.activo(guild.id)) {
        return interaction.editReply({
          embeds: [errorEmbed('Este servidor no tiene los canales de estadísticas activados. Prendelos con `/stats activar`.')],
        });
      }
      const { resultados } = await stats.refrescarGuild(guild);

      // Se informa lo que pasó de verdad: renombrado, agendado por el límite de Discord,
      // sin cambios, o rechazado (siempre con el motivo).
      const linea = (r) => {
        if (r.estado === 'renombrado') return `✅ \`${r.id}\` → \`${r.objetivo}\``;
        if (r.estado === 'sin-cambio') return `➖ \`${r.id}\` ya estaba en \`${r.objetivo}\``;
        if (r.estado === 'espera')
          return `⏳ \`${r.id}\` → \`${r.objetivo}\` (cupo de renombres usado, se aplica en ~${Math.round(r.reabreEnMs / 60000)} min)`;
        if (r.estado === 'perdido') return `⚠️ \`${r.id}\`: el canal no existe (recrealo con \`/stats metricas\`)`;
        return `⚠️ \`${r.id}\` → \`${r.objetivo}\` rechazado: \`${r.motivo}\``;
      };
      return interaction.editReply({ embeds: [successEmbed(resultados.map(linea).join('\n'), 'Refresco de estadísticas')] });
    }

    if (sub === 'desactivar') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const borrar = interaction.options.getBoolean('borrar') ?? true;
      const resultado = await stats.desactivar(guild, { borrar });
      const lineas = [
        borrar
          ? `Sistema **apagado** y ${resultado.borrados.length} de ${resultado.total} canal(es) borrados.`
          : 'Sistema **apagado**. Los canales quedaron como estaban (ya no se van a actualizar).',
      ];
      if (resultado.fallidos.length)
        lineas.push(`⚠️ No pude borrar ${resultado.fallidos.length}: ${resultado.fallidos.map((f) => `\`${f.id}\` (${f.motivo})`).join(' · ')}`);
      lineas.push('Para volver a prenderlos: `/stats activar`.');
      return interaction.editReply({ embeds: [successEmbed(lineas.join('\n'))] });
    }

    // sub === 'estado'
    const config = stats.configDe(guild.id);
    const activado = stats.activo(guild.id);
    const ids = stats.metricasActivas(guild.id);
    const datosCenso = censo.datosDe(guild.id);
    const pasada = stats.ultimaPasada(guild.id);
    const problemas = stats.diagnosticoStats(guild);

    const embed = brandEmbed({
      color: problemas.some((p) => p.nivel === 'error') ? COLORS.error : activado ? COLORS.servidor : COLORS.gris,
      title: 'Estadísticas del servidor',
      description:
        `**Estado:** ${activado ? '🟢 Activo' : '🔴 Apagado'}\n` +
        `**Categoría:** ${config.categoriaId ? `<#${config.categoriaId}>` : 'sin configurar (se crea al activar)'}\n` +
        `**Refresco:** cada ${Math.round(stats.INTERVALO_MS / 60000)} min · Discord permite ${stats.RENOMBRES_POR_VENTANA} renombres por canal cada 10 min\n` +
        `**Presence Intent:** ${censo.tienePresencias(guild.client) ? 'activo (se puede contar «en línea»)' : 'inactivo (el canal «En línea» queda en `—`)'}\n` +
        `**Censo de miembros:** ${datosCenso.cuando ? `completo ${marcaTiempo(datosCenso.cuando)} (${miles(datosCenso.bots)} bots)` : 'todavía sin foto completa'}`,
      fields: [
        {
          name: `Canales (${ids.length})`,
          value: ids.length ? ids.map((id) => lineaCanal(guild, id)).join('\n') : '*ninguno: activalos con `/stats activar`*',
        },
        ...(pasada
          ? [
              {
                name: 'Última pasada',
                value:
                  `${marcaTiempo(pasada.cuando)} · ${pasada.renombrados} renombrado(s)` +
                  `${pasada.resultados.filter((r) => r.estado === 'espera').length ? ` · ${pasada.resultados.filter((r) => r.estado === 'espera').length} en espera de cupo` : ''}` +
                  `${pasada.fallidos ? ` · ⚠️ ${pasada.fallidos} con problema` : ''}`,
              },
            ]
          : []),
        { name: 'Métricas disponibles', value: catalogo() },
        ...(problemas.length
          ? [{ name: 'Diagnóstico', value: problemas.map((p) => `${p.nivel === 'error' ? '⛔' : '⚠️'} ${p.texto}`).join('\n') }]
          : []),
      ],
      footer: 'TriggerBOT • los canales son de solo lectura: nadie puede entrar a hablar ahí',
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
