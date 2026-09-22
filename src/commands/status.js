// /status — estado del bot con botón de refresco: se re-mide todo (latencia, memoria,
// CPU, IAs, BD) y se edita el mismo mensaje, sin reescribir el comando.
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { estadoIA, getStatsIA } = require('../utils/ia');
const { brandEmbed, miles, duracion, UMBRALES, nivel } = require('../utils/replies');
const db = require('../db/mariadb');

// Snapshot de CPU al arrancar el módulo, para calcular el uso medio del proceso.
const inicioCPU = process.cpuUsage();
const inicioMs = Date.now();

const REFRESH_ID = 'status:refresh';

// Arma el embed con mediciones ya hechas (lo comparten el slash y el botón refrescar).
function vistaStatus(client, m) {
  const chipIA = (proveedor) => (proveedor.configurada ? `\`${proveedor.modelo}\`` : '`—` sin clave');

  const embed = brandEmbed({
    color: m.color,
    title: `${db.configurada && !m.dbOk ? '❌' : m.degradado ? '🟠' : '🟢'} Estado de TriggerBOT — ${m.estadoGeneral}`,
    thumbnail: client.user.displayAvatarURL({ size: 256 }),
    description:
      `**${client.commands.size} comandos** cargados en **${client.guilds.cache.size}** servidor(es). ` +
      `Escribí en cualquier canal y el bot responde.`,
    fields: [
      {
        name: '⚡ Rendimiento',
        value:
          `**Latencia API:** ${m.api === null ? '⏳ midiendo…' : `${m.calPing.emoji} ${m.api} ms (${m.calPing.texto})`}\n` +
          `**Memoria:** ${m.calMem.emoji} ${m.mem} MB en uso (${m.heap} MB de JS)\n` +
          `**CPU:** ${m.cpu.toFixed(1)} % de promedio`,
        inline: false,
      },
      { name: '⏱️ Tiempo encendido', value: `**${duracion(process.uptime())}**`, inline: true },
      { name: '🟢 Node.js', value: `\`${process.version}\``, inline: true },
      { name: '🧠 IA principal (Groq)', value: chipIA(m.ia.groq), inline: true },
      { name: '🧠 Respaldo (Gemini)', value: chipIA(m.ia.gemini), inline: true },
      { name: '💬 Respuestas de IA', value: m.statsIA, inline: false },
      { name: '🗄️ Base de datos (MariaDB)', value: m.textoDB, inline: false },
    ],
    footer: `TriggerBOT v1.0.0 • Uptime del proceso • ${new Date().toLocaleDateString('es-AR')}`,
  });

  const fila = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(REFRESH_ID).setLabel('Refrescar').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [fila] };
}

// Mide todo el estado (rendimiento, IAs y BD). Devuelve los valores crudos para vistaStatus.
async function medir(client) {
  const ia = await estadoIA();
  const stats = getStatsIA();
  const dbOk = db.configurada ? await db.ping() : false;

  // ---------- Rendimiento ----------
  const apiBruta = Math.round(client.ws.ping);
  const api = apiBruta >= 0 ? apiBruta : null;
  const calPing = api !== null ? nivel(api, UMBRALES.ping) : null;

  const mem = Math.round(process.memoryUsage().rss / 1048576);
  const heap = Math.round(process.memoryUsage().heapUsed / 1048576);
  const calMem = nivel(mem, UMBRALES.memoria);

  const delta = process.cpuUsage(inicioCPU);
  const transcurrido = Math.max(Date.now() - inicioMs, 1);
  const cpu = ((delta.user + delta.system) / 1000 / transcurrido) * 100; // % medio desde el arranque

  // ---------- IA ----------
  const iaOk = ia.groq.configurada || ia.gemini.configurada;
  const totalRespuestas = stats.groq + stats.gemini + stats.local;
  const statsIA =
    totalRespuestas === 0
      ? 'Sin conversaciones todavía'
      : `Groq: **${miles(stats.groq)}** · Gemini: **${miles(stats.gemini)}** · Local: **${miles(stats.local)}**`;

  // ---------- Base de datos ----------
  let textoDB;
  if (!db.configurada) textoDB = '⚪ No configurada — guardando solo en `data/` local';
  else if (dbOk && db.estado.permisoEscritura === false)
    textoDB = '⚠️ Conectada **sin permiso de escritura**: revisá los GRANT del usuario `DB_USER` sobre la base.';
  else if (dbOk) {
    const hace = db.estado.ultimaSync ? ` · último hace ${duracion((Date.now() - db.estado.ultimaSync.getTime()) / 1000)}` : '';
    textoDB = `✅ Conectada — **${miles(db.estado.subidasOk)}** respaldos en la nube${hace}`;
  } else textoDB = `❌ Error de conexión${db.estado.ultimoError ? `: \`${db.estado.ultimoError}\`` : ''}`;

  // Color general: verde si todo bien; amarillo si algo está degradado; rojo si la BD configurada falla.
  const degradado = (api !== null && api > UMBRALES.ping.ok) || !iaOk;
  const color = db.configurada && !dbOk ? 0xed4245 : degradado ? 0xfee75c : 0x57f287;
  const estadoGeneral = db.configurada && !dbOk ? 'Degradado' : degradado ? 'Funcionando con avisos' : 'Todo en orden';

  return { ia, dbOk, api, calPing, mem, heap, calMem, cpu, statsIA, textoDB, degradado, color, estadoGeneral };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Muestra el estado del bot: IAs, latencia y servicios'),

  async execute(interaction, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const m = await medir(client);
    return interaction.editReply(vistaStatus(client, m));
  },

  // Botón 🔄: re-mide todo y edita el mismo mensaje. Como la respuesta original
  // es efímera, solo quien la abrió puede refrescarla: no hay fuga de datos.
  async boton(interaction, client) {
    await interaction.deferUpdate();
    const m = await medir(client);
    await interaction.editReply(vistaStatus(client, m)).catch(() => {});
  },
};
