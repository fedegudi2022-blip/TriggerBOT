// /servidores — estado en vivo de los servers CS 1.6 de la comunidad.
// Consulta A2S en el momento; con `publicar` deja un panel fijo que el monitoreo
// actualiza solo cada 90 s (Estado/Jugadores/Mapa/IP siempre frescos).
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { brandEmbed } = require('../utils/replies');
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

    // Consulta todos los servers en paralelo y arma una tarjeta por server (como la web).
    const resultados = await Promise.all(
      servers.map(async (server) => {
        const [host, puerto] = monitoreo.parsearDestino(server);
        const resultado = await monitoreo.consultar(host, puerto);
        return { server, host, puerto, resultado };
      })
    );

    const tarjetas = resultados.map(({ server, host, puerto, resultado }) => {
      const snapshot = resultado.ok ? resultado : { ok: false };
      return monitoreo.tarjetaServidor(server, host, puerto, snapshot);
    });

    return interaction.reply({ embeds: tarjetas.slice(0, 10) });
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
    await mensaje.edit({ embeds: construirPanel(guild, config, instantaneas) }).catch(() => {});
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
