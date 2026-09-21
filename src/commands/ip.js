// /ip — la IP para conectar, lista para copiar. Sin args muestra todas; con
// filtro muestra solo ese server con su mapa y jugadores de ahora mismo.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { brandEmbed } = require('../utils/replies');
const monitoreo = require('../utils/monitoreo');
const { getGuildConfig } = require('../store');

// Compara sin acentos ni mayúsculas: "publico" encuentra "PÚBLICO CLÁSICO".
function normalizar(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
        embeds: [brandEmbed({ color: 0xfee75c, title: '🎮 Sin servidores configurados', description: 'El staff todavía no los cargó en `/config → Servidores CS 1.6`.' })],
        flags: MessageFlags.Ephemeral,
      });
    }

    const filtro = normalizar(interaction.options.getString('servidor') ?? '').trim();
    const elegidos = filtro
      ? servers.filter((s) => normalizar(s.nombre || '').includes(filtro) || normalizar(s.modo || '').includes(filtro))
      : servers;

    if (!elegidos.length) {
      return interaction.reply({
        embeds: [brandEmbed({ color: 0xfee75c, title: '🎮 No encontré ese servidor', description: `Probá con: ${servers.map((s) => `\`${s.nombre}\``).join(' · ')}` })],
        flags: MessageFlags.Ephemeral,
      });
    }

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
      const conMapa = filtro
        ? ` — 🗺️ \`${d.mapa}\` — ${estado(d.jugadores, d.maximo)} **${d.jugadores}/${d.maximo}**`
        : '';
      return `**${server.nombre}**${conMapa}\n> \`${host}:${puerto}\``;
    });

    const embed = brandEmbed({
      color: 0x57f287,
      title: '🔗 IPs para conectarte',
      description: lineas.join('\n\n') + '\n\n**Cómo entrar:** copiá la IP → abrí CS 1.6 → consola (`~`) → `connect IP`',
      footer: 'TriggerBOT • /servidores para ver el estado completo en vivo',
    });

    return interaction.reply({ embeds: [embed] });
  },
};
