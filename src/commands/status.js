const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { estadoIA, getStatsIA } = require('../utils/ia');
const { brandEmbed, miles, duracion, UMBRALES, nivel } = require('../utils/replies');
const db = require('../db/supabase');

// Snapshot de CPU al arrancar el módulo, para calcular el uso medio del proceso.
const inicioCPU = process.cpuUsage();
const inicioMs = Date.now();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Muestra el estado del bot: IAs, latencia y servicios'),

  async execute(interaction, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
    const chipIA = (proveedor) =>
      proveedor.configurada ? `\`${proveedor.modelo}\`` : '`—` sin clave';

    // ---------- Base de datos ----------
    let textoDB;
    if (!db.configurada) textoDB = '⚪ No configurada — guardando solo en `data/` local';
    else if (dbOk && db.estado.permisoEscritura === false)
      textoDB = '⚠️ Conectada **sin permiso de escritura**: la clave parece ser la anon. Usá la `service_role` en `SUPABASE_KEY`.';
    else if (dbOk) {
      const hace = db.estado.ultimaSync ? ` · último hace ${duracion((Date.now() - db.estado.ultimaSync.getTime()) / 1000)}` : '';
      textoDB = `✅ Conectada — **${miles(db.estado.subidasOk)}** respaldos en la nube${hace}`;
    } else textoDB = `❌ Error de conexión${db.estado.ultimoError ? `: \`${db.estado.ultimoError}\`` : ''}`;

    // Color general: verde si todo bien; amarillo si algo está degradado; rojo si la BD configurada falla.
    const degradado = (api !== null && api > UMBRALES.ping.ok) || !iaOk;
    const color = db.configurada && !dbOk ? 0xed4245 : degradado ? 0xfee75c : 0x57f287;
    const estadoGeneral = db.configurada && !dbOk ? 'Degradado' : degradado ? 'Funcionando con avisos' : 'Todo en orden';

    const embed = brandEmbed({
      color,
      title: `${db.configurada && !dbOk ? '❌' : degradado ? '🟠' : '🟢'} Estado de TriggerBOT — ${estadoGeneral}`,
      thumbnail: client.user.displayAvatarURL({ size: 256 }),
      description:
        `**${client.commands.size} comandos** cargados en **${client.guilds.cache.size}** servidor(es). ` +
        `Escribí en cualquier canal y el bot responde.`,
      fields: [
        {
          name: '⚡ Rendimiento',
          value:
            `**Latencia API:** ${api === null ? '⏳ midiendo…' : `${calPing.emoji} ${api} ms (${calPing.texto})`}\n` +
            `**Memoria:** ${calMem.emoji} ${mem} MB en uso (${heap} MB de JS)\n` +
            `**CPU:** ${cpu.toFixed(1)} % de promedio`,
          inline: false,
        },
        { name: '⏱️ Tiempo encendido', value: `**${duracion(process.uptime())}**`, inline: true },
        { name: '🟢 Node.js', value: `\`${process.version}\``, inline: true },
        { name: '🧠 IA principal (Groq)', value: chipIA(ia.groq), inline: true },
        { name: '🧠 Respaldo (Gemini)', value: chipIA(ia.gemini), inline: true },
        { name: '💬 Respuestas de IA', value: statsIA, inline: false },
        { name: '🗄️ Base de datos (Supabase)', value: textoDB, inline: false },
      ],
      footer: `TriggerBOT v1.0.0 • Uptime del proceso • ${new Date().toLocaleDateString('es-AR')}`,
    });

    return interaction.editReply({ embeds: [embed] });
  },
};
