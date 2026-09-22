// /voz — configura el sistema de canales de voz temporales (Join-to-Create).
// El staff crea el canal hub con un clic y los usuarios entran para tener su
// canal propio con controles; se borra solo cuando queda vacío.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { setGuildConfig } = require('../store');
const { successEmbed, errorEmbed, brandEmbed } = require('../utils/replies');
const voz = require('../utils/voz');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('voz')
    .setDescription('Canales de voz temporales: cada usuario crea el suyo al entrar (solo staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sc) => sc.setName('activar').setDescription('Crea el canal «➕ Crear canal» y activa el sistema'))
    .addSubcommand((sc) =>
      sc
        .setName('hub')
        .setDescription('Usa un canal de voz existente como canal de creación')
        .addChannelOption((o) => o.setName('canal').setDescription('Canal de voz que actúa como hub').setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('categoria')
        .setDescription('Elige la categoría donde se crean los canales temporales')
        .addChannelOption((o) => o.setName('categoria').setDescription('Categoría destino (si no, se crea junto al hub)').setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('contador')
        .setDescription('Muestra cuántos hay en cada canal: «🔊 Canal de X · 3/5»')
        .addBooleanOption((o) =>
          o.setName('activado').setDescription('Prender o apagar el contador en el nombre del canal').setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('logs')
        .setDescription('Qué eventos de voz se registran en el canal de logs')
        .addStringOption((o) =>
          o.setName('nivel').setDescription('Cantidad de registros').setRequired(true).addChoices(
            { name: 'solo errores (recomendado)', value: 'errores' },
            { name: 'todo — cada creación, transferencia y borrado', value: 'todo' },
            { name: 'nada — silenciar el registro de voz', value: 'nada' }
          )
        )
    )
    .addSubcommand((sc) => sc.setName('desactivar').setDescription('Apaga el sistema y borra el canal de creación'))
    .addSubcommand((sc) =>
      sc
        .setName('formato')
        .setDescription('Cambia el nombre de los canales temporales')
        .addStringOption((o) =>
          o.setName('plantilla').setDescription('Usá {usuario} donde va el nombre. Ej: «🔊 Canal de {usuario}»').setMaxLength(90)
        )
    )
    .addSubcommand((sc) => sc.setName('estado').setDescription('Muestra la configuración y los canales temporales activos')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'activar') {
      const config = voz.vozDe?.(interaction.guildId);
      if (config?.hubId && interaction.guild.channels.cache.get(config.hubId)) {
        return interaction.reply({
          embeds: [errorEmbed('El sistema ya está activo. Usá `/voz desactivar` primero si querés rehacer el hub.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const categoria = interaction.channel?.parentId ?? undefined;
      const hub = await interaction.guild.channels.create({
        name: voz.NOMBRE_HUB,
        type: ChannelType.GuildVoice,
        parent: categoria,
        permissionOverwrites: [],
      });
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        c.voz.hubId = hub.id;
      });
      return interaction.editReply({
        embeds: [
          successEmbed(
            `Canal **${voz.NOMBRE_HUB}** creado en esta categoría.\nCuando alguien entre, se le crea **su propio canal de voz** con panel de controles ` +
              '(renombrar, límite, cerrar, expulsar, transferir). Se borra solo cuando queda vacío.\n' +
              '📍 Elegí la categoría donde se crean con `/voz categoria`.'
          ),
        ],
      });
    }

    if (sub === 'hub') {
      const canal = interaction.options.getChannel('canal', true);
      if (canal.type !== ChannelType.GuildVoice) {
        return interaction.reply({ embeds: [errorEmbed('El hub tiene que ser un canal **de voz**.')], flags: MessageFlags.Ephemeral });
      }
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        c.voz.hubId = canal.id;
      });
      return interaction.reply({
        embeds: [
          successEmbed(
            `**${canal.name}** ahora es el canal de creación: al entrar, cada usuario recibe su canal propio.` +
              '\n📍 Los canales se crean en la categoría elegida con `/voz categoria`.'
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'categoria') {
      const categoria = interaction.options.getChannel('categoria', true);
      if (categoria.type !== ChannelType.GuildCategory) {
        return interaction.reply({
          embeds: [errorEmbed('Tenés que elegir una **categoría** (la cabecera que agrupa canales), no un canal de voz o texto.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        c.voz.categoriaId = categoria.id;
      });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const movidos = await voz.moverTemporalesACategoria(interaction.guild, categoria.id);
      return interaction.editReply({
        embeds: [
          successEmbed(
            `Categoría configurada: **${categoria.name}**.\nLos canales temporales de los usuarios se crean ahí.` +
              (movidos.length
                ? `\n📦 ${movidos.length} canal(es) ya existente(s) se movieron a la nueva categoría (conservando sus permisos).`
                : '')
          ),
        ],
      });
    }

    if (sub === 'contador') {
      const activado = interaction.options.getBoolean('activado', true);
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        c.voz.contador = activado;
      });
      return interaction.reply({
        embeds: [
          successEmbed(
            activado
              ? '🔢 Contador **prendido**: los canales muestran cuántos hay adentro («· 3», o «· 3/5» con límite).\n Discord limita los renombres a 2 por canal cada 10 min: el bot junta cambios y aplica el valor más nuevo apenas puede.'
              : '🔢 Contador **apagado**: los nombres vuelven a quedar sin cantidad en el próximo cambio de gente.'
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'logs') {
      const nivel = interaction.options.getString('nivel', true);
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        c.voz.eventos = nivel;
      });
      const detalle = {
        todo: 'Se registra **cada** creación, transferencia y borrado de canales temporales.',
        errores: 'Solo se registran los **fallos** (no se pudo crear un canal). Los eventos rutinarios quedan en silencio.',
        nada: 'Sin registros de voz. Si algo falla, igual te avisamos en el chat del canal de creación.',
      };
      return interaction.reply({
        embeds: [successEmbed(`Registros de voz actualizados: **${nivel}**.\n${detalle[nivel]}`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'desactivar') {
      const config = voz.vozDe(interaction.guildId);
      if (!config.hubId) {
        return interaction.reply({ embeds: [errorEmbed('El sistema no está activo.')], flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const hub = interaction.guild.channels.cache.get(config.hubId);
      if (hub) await hub.delete('Sistema de canales de voz desactivado').catch(() => {});
      setGuildConfig(interaction.guildId, (c) => {
        if (c.voz) delete c.voz.hubId;
      });
      return interaction.editReply({ embeds: [successEmbed('Sistema desactivado. Los canales temporales ya creados se borran solos al vaciarse.')] });
    }

    if (sub === 'formato') {
      const plantilla = interaction.options.getString('plantilla')?.trim();
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        if (plantilla) c.voz.formato = plantilla;
        else delete c.voz.formato;
      });
      return interaction.reply({
        embeds: [
          successEmbed(
            plantilla
              ? `Formato actualizado: **${voz.nombreCanal(plantilla, 'Federico')}**`
              : `Volvimos al formato por defecto: **${voz.PLANTILLA_NOMBRE}**.`
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'estado') {
      const config = voz.vozDe(interaction.guildId);
      const hub = config.hubId ? interaction.guild.channels.cache.get(config.hubId) : null;
      const categoria = config.categoriaId ? interaction.guild.channels.cache.get(config.categoriaId) : null;
      const temporales = Object.entries(voz.temporalesDe(interaction.guildId));

      // Diagnóstico: el bot necesita “Gestionar canales” en la categoría destino (o en el hub).
      const bot = interaction.guild.members.me;
      const destino = categoria ?? hub?.parent ?? null;
      const puedeCrear = destino ? bot?.permissionsIn(destino)?.has(PermissionFlagsBits.ManageChannels) ?? false : true;
      const avisoPermisos = categoria && !puedeCrear ? '\n⚠️ **El bot no tiene permiso de crear canales en esa categoría** (falta “Gestionar canales” para el rol del bot).' : '';
      const lista = temporales
        .map(([canalId, duenoId]) => {
          const canal = interaction.guild.channels.cache.get(canalId);
          return canal ? `• **${canal.name}** — dueño: <@${duenoId}> (${canal.members.size} adentro)` : null;
        })
        .filter(Boolean)
        .join('\n');

      const embed = brandEmbed({
        color: 0x5865f2,
        title: '🎧 Canales de voz temporales',
        description:
          `**Estado:** ${hub ? '🟢 Activo' : '🔴 Inactivo'}\n` +
          `**Canal de creación:** ${hub ? hub.name : 'sin configurar'}\n` +
          `**Categoría destino:** ${categoria ? categoria.name : 'la del hub (sin configurar)'}${destino ? (puedeCrear ? ' ✅' : ' ❌') : ''}\n` +
          `**Formato:** ${config.formato || voz.PLANTILLA_NOMBRE}\n` +
          `**Registros:** ${config.eventos || 'errores (por defecto)'}\n` +
          `**Contador en el nombre:** ${config.contador === false ? 'apagado' : 'prendido (por defecto)'}\n\n` +
          `**Canales activos (${temporales.length}):**\n${lista || '*ninguno en este momento*'}${avisoPermisos}`,
      });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
};
