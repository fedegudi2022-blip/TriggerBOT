// /servidores — estado en vivo de los servers CS 1.6 de la comunidad.
// Consulta A2S en el momento; con `publicar` deja un panel fijo que el monitoreo
// actualiza solo cada 90 s (Estado/Jugadores/Mapa/IP siempre frescos).
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { brandEmbed, barra } = require('../utils/replies');
const monitoreo = require('../utils/monitoreo');
const { getGuildConfig, setGuildConfig } = require('../store');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('servidores')
    .setDescription('Muestra el estado en vivo de los servidores CS 1.6 de la comunidad')
    .addBooleanOption((o) =>
      o.setName('publicar').setDescription('Staff: publica acá el panel que se actualiza solo')
    ),

  async execute(interaction) {
    const guild = interaction.guild;
    const config = getGuildConfig(guild.id).servidores;
    const servers = config?.lista ?? [];

    if (!servers.length) {
      return interaction.reply({
        embeds: [
          brandEmbed({
            color: 0xfee75c,
            title: '🎮 Sin servidores configurados',
            description: 'El staff todavía no cargó los servers. Se agregan desde `/config → Servidores CS 1.6`.',
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Publicar el panel fijo: no hace falta consultar nada acá, el monitoreo lo llena.
    if (interaction.options.getBoolean('publicar')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          embeds: [brandEmbed({ color: 0xed4245, title: 'Solo el staff puede publicar el panel' })],
          flags: MessageFlags.Ephemeral,
        });
      }
      return publicarPanel(interaction);
    }

    // Consulta todos los servers en paralelo (con timeout corto para responder rápido).
    const resultados = await Promise.all(
      servers.map(async (server) => {
        const [host, puerto] = monitoreo.parsearDestino(server);
        const resultado = await monitoreo.consultar(host, puerto);
        return { server, host, puerto, resultado };
      })
    );

    const lineas = resultados.map(({ server, host, puerto, resultado }, i) => {
      if (!resultado.ok) {
        return `**${i + 1}.** ${server.nombre}\n> 🔴 **Caído** — no responde\n> \`${host}:${puerto}\``;
      }
      const d = resultado.datos;
      const ocup = d.maximo ? d.jugadores / d.maximo : 0;
      const estado = ocup >= 0.9 ? '🔴' : ocup >= 0.6 ? '🟡' : '🟢';
      const aviso = monitoreo.notaDifiere(server, d);
      return (
        `**${i + 1}.** ${server.nombre}${aviso}\n` +
        `> ${estado} **${d.jugadores}/${d.maximo}** jugadores — 🗺️ \`${d.mapa}\` — ⏱️ ${resultado.latenciaMs} ms\n` +
        `> \`${barra(d.jugadores, d.maximo, 10)}\`\n` +
        `> 🔗 \`${host}:${puerto}\` — copiá y conect`
      );
    });

    const online = resultados.filter((r) => r.resultado.ok).length;
    const jugadores = resultados.reduce((s, r) => s + (r.resultado.ok ? r.resultado.datos.jugadores : 0), 0);

    const embed = brandEmbed({
      color: online === 0 ? 0xed4245 : online === servers.length ? 0x57f287 : 0xfee75c,
      title: '🎮 Servidores TriGGer.Arena',
      description:
        `**${online}/${servers.length}** servers online · **${jugadores}** jugadores jugando ahora.\n\n${lineas.join('\n\n')}`,
      footer: `TriggerBOT • consultado ahora • ${new Date().toLocaleTimeString('es-AR')}`,
    });

    return interaction.reply({ embeds: [embed] });
  },
};

// Publica el panel fijo y guarda canal+mensaje en la config para el monitoreo.
async function publicarPanel(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const mensaje = await interaction.channel.send({
    embeds: [brandEmbed({ color: 0x5865f2, title: '🎮 Panel de servidores', description: 'Generando panel…' })],
  });

  setGuildConfig(guild.id, (c) => {
    c.servidores = c.servidores || {};
    c.servidores.canalPanel = interaction.channelId;
    c.servidores.mensajePanel = mensaje.id;
  });

  // Primer render inmediato con lo que haya en caché (sin esperar el próximo tick).
  const config = getGuildConfig(guild.id).servidores;
  const instantaneas = new Map();
  for (const server of config.lista ?? []) {
    const [host, puerto] = monitoreo.parsearDestino(server);
    const cacheado = monitoreo.cache.get(`${host}:${puerto}`);
    if (cacheado) instantaneas.set(`${host}:${puerto}`, cacheado);
  }
  if (config.lista?.length) {
    const { construirPanel } = require('../utils/monitoreo');
    await mensaje.edit({ embeds: [construirPanel(guild, config, instantaneas)] }).catch(() => {});
  }

  return interaction.editReply({
    embeds: [
      brandEmbed({
        color: 0x57f287,
        title: '📌 Panel publicado',
        description: `El panel se actualiza solo cada 90 s en <#${interaction.channelId}>. Para moverlo, volvé a usar /servidores → publicar en el canal nuevo.`,
      }),
    ],
  });
}
