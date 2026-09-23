// /ip — la IP para conectar, lista para copiar. Sin args muestra todas; con
// filtro muestra solo ese server con su mapa y jugadores de ahora mismo.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { successEmbed, warnEmbed } = require('../utils/replies');
const monitoreo = require('../utils/monitoreo');
const { getGuildConfig } = require('../store');

// Compara sin acentos ni mayúsculas: "publico" encuentra "PÚBLICO CLÁSICO".
function normalizar(t) {
  return String(t)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Emoji según la ocupación del server.
function estado(jug, max) {
  const ocup = max ? jug / max : 0;
  return ocup >= 0.9 ? '🔴' : ocup >= 0.6 ? '🟡' : '🟢';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ip')
    .setDescription('IP de los servidores para conectarte (se copia con un toque)')
    .addStringOption((o) => o.setName('servidor').setDescription('Filtrá por nombre (ej: publico, kz, automix)')),

  async execute(interaction) {
    const config = getGuildConfig(interaction.guild.id).servidores;
    const servers = config?.lista ?? [];

    if (!servers.length) {
      return interaction.reply({
        embeds: [warnEmbed('El staff todavía no los cargó en `/config → Servidores CS 1.6`.', '🎮 Sin servidores configurados')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const filtro = normalizar(interaction.options.getString('servidor') ?? '').trim();
    const elegidos = filtro
      ? servers.filter((s) => normalizar(s.nombre || '').includes(filtro) || normalizar(s.modo || '').includes(filtro))
      : servers;

    if (!elegidos.length) {
      return interaction.reply({
        embeds: [warnEmbed(`Probá con: ${servers.map((s) => `\`${s.nombre}\``).join(' · ')}`, '🎮 No encontré ese servidor')],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Diferido antes de las consultas A2S: cada server puede tardar hasta su timeout
    // y sin esto Discord cierra la interacción antes de que lleguen los datos.
    await interaction.deferReply();

    const resultados = await Promise.all(
      elegidos.map(async (server) => {
        const [host, puerto] = monitoreo.parsearDestino(server);
        const resultado = await monitoreo.consultar(host, puerto);
        return { server, host, puerto, resultado };
      })
    );

    const lineas = resultados.map(({ server, host, puerto, resultado }) => {
      if (!resultado.ok) return `**${server.nombre}** — 🔴 caído\n> \`${host}:${puerto}\``;

      const d = resultado.datos;
      const conMapa = filtro ? ` — 🗺️ \`${d.mapa}\` — ${estado(d.jugadores, d.maximo)} **${d.jugadores}/${d.maximo}**` : '';
      return `**${server.nombre}**${conMapa}\n> \`${host}:${puerto}\``;
    });

    const embed = successEmbed(
      lineas.join('\n\n') + '\n\n**Cómo entrar:** copiá la IP → abrí CS 1.6 → consola (`~`) → `connect IP`',
      '🔗 IPs para conectarte'
    );
    embed.setFooter({ text: 'TriggerBOT • /servidores para ver el estado completo en vivo' });

    return interaction.editReply({ embeds: [embed] });
  },
};
