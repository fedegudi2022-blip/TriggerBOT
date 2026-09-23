// /diag — diagnóstico operativo para el staff.
//
// A diferencia de /status (que mide rendimiento), acá la pregunta es otra:
// "¿qué está roto y qué tengo que hacer?". Los problemas NO se arman acá: salen de
// utils/vigilancia.js, la MISMA fuente que dispara los avisos automáticos al canal de
// staff. Si el bot avisó algo, este comando lo muestra igual; si acá no hay nada, el
// bot tampoco tiene de qué avisar.
//
// No modifica nada: solo informa y recomienda.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getGuildConfig, pendientesDeGuardado } = require('../store');
const { brandEmbed, COLORS, miles, duracion, marcaTiempo } = require('../utils/replies');
const { revisar } = require('../utils/vigilancia');

const REFRESH_ID = 'diag:refresh';

// Estado de cada sistema en una línea, sin adornos: para diagnosticar, no para lucirse.
async function resumenSistemas(client, guild) {
  const campos = [];

  // ---------- IA ----------
  try {
    const ia = require('../utils/ia');
    const estado = await ia.estadoIA();
    const linea = (nombre, p) => {
      if (!p.configurada) return `${nombre}: sin clave`;
      if (p.enPausa) return `${nombre}: ⏸️ ${p.motivoPausa}`;
      if (!p.modelo) return `${nombre}: ❌ sin modelos utilizables`;
      const latencia = p.p50 != null ? ` · ${p.p50} ms de mediana (${p.muestras} resp.)` : ' · sin muestras';
      const bajas = p.modelosCaidos.length ? ` · ${p.modelosCaidos.length} modelo(s) descartado(s)` : '';
      return `${nombre}: \`${p.modelo}\`${latencia}${bajas}`;
    };
    campos.push({ name: '🧠 IA', value: `${linea('Groq', estado.groq)}\n${linea('Gemini', estado.gemini)}`, inline: false });
  } catch (error) {
    campos.push({ name: '🧠 IA', value: `❌ No se pudo consultar: ${error.message}`, inline: false });
  }

  // ---------- Base de datos ----------
  try {
    const db = require('../db/mariadb');
    let texto;
    if (!db.configurada) texto = 'No configurada: solo guardado local en `data/`.';
    else if (!db.estado.conectado) texto = `❌ Sin conexión — \`${db.estado.ultimoError || 'error desconocido'}\``;
    else {
      const hace = db.estado.ultimaSync ? ` · última subida ${duracion((Date.now() - db.estado.ultimaSync.getTime()) / 1000)} atrás` : '';
      const permiso = db.estado.permisoEscritura === false ? '\n⚠️ **Sin permiso de escritura**: no está respaldando.' : '';
      texto = `✅ Conectada — ${miles(db.estado.subidasOk)} subida(s) OK, ${miles(db.estado.subidasFallidas)} fallida(s)${hace}${permiso}`;
    }
    const pendientes = require('../db/sync').pendientesDeSubida();
    campos.push({ name: '🗄️ Base de datos', value: `${texto}\nPendientes de subir: **${pendientes}**`, inline: false });
  } catch {
    campos.push({ name: '🗄️ Base de datos', value: 'Módulo no disponible.', inline: false });
  }

  // ---------- Monitoreo de servidores CS ----------
  try {
    const monitoreo = require('../utils/monitoreo');
    const lista = getGuildConfig(guild.id).servidores?.lista ?? [];
    if (!lista.length) campos.push({ name: '📡 Servidores CS 1.6', value: 'Ninguno cargado.', inline: false });
    else {
      let frescos = 0;
      let masViejo = null;
      for (const server of lista) {
        const [host, puerto] = monitoreo.parsearDestino(server);
        const snap = monitoreo.cache.get(`${host}:${puerto}`);
        if (snap?.cuando) {
          frescos += 1;
          masViejo = Math.max(masViejo ?? 0, Date.now() - snap.cuando);
        }
      }
      const edad = masViejo === null ? 'sin datos' : `dato más nuevo hace ${duracion(masViejo / 1000)}`;
      campos.push({
        name: '📡 Servidores CS 1.6',
        value: `**${frescos}/${lista.length}** con datos · ${edad}\nSe renueva cada ${Math.round(monitoreo.INTERVALO_MS / 1000)} s`,
        inline: false,
      });
    }
  } catch {
    /* sin monitoreo */
  }

  // ---------- Voz ----------
  try {
    const voz = require('../utils/voz');
    const config = voz.vozDe(guild.id);
    const temporales = Object.keys(voz.temporalesDe(guild.id)).length;
    const hub = config.hubId ? guild.channels.cache.get(config.hubId) : null;
    campos.push({
      name: '🎧 Canales de voz',
      value: hub
        ? `Hub **${hub.name}** · ${temporales}/${voz.limiteCanales(guild.id)} canal(es) temporal(es) en uso`
        : 'Sistema sin activar (no hay hub configurado).',
      inline: false,
    });
  } catch {
    /* sin voz */
  }

  // ---------- Escrituras y proceso ----------
  const escritura = pendientesDeGuardado();
  const carga = client.fallosCarga?.length ? `⚠️ ${client.fallosCarga.length} archivo(s) no cargaron` : '✅ Todo cargado';
  campos.push({
    name: '💾 Escrituras y proceso',
    value:
      `Config sin guardar: **${escritura.guilds}** (la más vieja hace ${duracion(escritura.masViejoMs / 1000)})\n` +
      `Uptime: **${duracion(process.uptime())}** · memoria **${Math.round(process.memoryUsage().rss / 1048576)} MB** · ping **${Math.round(client.ws.ping)} ms**\n` +
      `${carga} · ${client.commands.size} comando(s) · ${client.guilds.cache.size} servidor(es)`,
    inline: false,
  });

  return campos;
}

async function vistaDiag(client, guild, { ping = true } = {}) {
  const { problemas, chequeos } = await revisar(client, { ping });
  const errores = problemas.filter((p) => p.nivel === 'error');
  const avisos = problemas.filter((p) => p.nivel !== 'error');

  const titulo = errores.length
    ? `🚨 Diagnóstico — ${errores.length} problema(s) crítico(s)`
    : avisos.length
      ? `⚠️ Diagnóstico — ${avisos.length} aviso(s)`
      : '✅ Diagnóstico — todo en orden';

  const detalle = problemas.length
    ? problemas
        .map((p) => `${p.nivel === 'error' ? '🔴' : '🟡'} **${p.titulo}**\n${p.detalle}\n> ${p.accion}`)
        .join('\n\n')
    : `Revisé **${chequeos.length} sistema(s)** y no encontré nada roto:\n${chequeos.map((c) => `• ${c}`).join('\n')}\n\nLos avisos automáticos van al canal configurado en \`/config → Avisos al staff\`.`;

  const embed = brandEmbed({
    color: errores.length ? COLORS.error : avisos.length ? COLORS.warn : COLORS.success,
    title: titulo,
    description: detalle.slice(0, 4000),
    fields: await resumenSistemas(client, guild),
    footer: `TriggerBOT • revisado ${marcaTiempo(Date.now())} • ${chequeos.length} chequeo(s)`,
  });

  const fila = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(REFRESH_ID).setLabel('Volver a revisar').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [fila] };
}

module.exports = {
  // `vistaDiag` se exporta para los tests: es donde vive el render del diagnóstico.
  vistaDiag,

  data: new SlashCommandBuilder()
    .setName('diag')
    .setDescription('Diagnóstico operativo del bot: qué está roto y qué hacer (staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply(await vistaDiag(client, interaction.guild));
  },

  // Botón 🔄: vuelve a correr los chequeos y edita el mismo mensaje.
  async boton(interaction, client) {
    await interaction.deferUpdate();
    await interaction.editReply(await vistaDiag(client, interaction.guild)).catch(() => {});
  },
};
