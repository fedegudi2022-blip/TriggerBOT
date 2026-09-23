// /voz — configura el sistema de canales de voz temporales (Join-to-Create).
// El staff crea el canal hub con un clic y los usuarios entran para tener su
// canal propio con controles; se borra solo cuando queda vacío.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
        .addBooleanOption((o) =>
          o
            .setName('permitir_fallback')
            .setDescription('Si la categoría falla, permitir crear en la categoría del hub (desordenado: mejor no)')
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('contador')
        .setDescription('Muestra cuántos hay en cada canal: «🔊 Canal de X · 3/5»')
        .addBooleanOption((o) => o.setName('activado').setDescription('Prender o apagar el contador en el nombre del canal').setRequired(true))
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
    .addSubcommand((sc) =>
      sc
        .setName('limite')
        .setDescription('Tope de canales temporales que el bot crea por servidor (anti-flood)')
        .addIntegerOption((o) =>
          o.setName('canales').setDescription('Cantidad de canales temporales permitidos (1-50)').setMinValue(1).setMaxValue(50).setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('desactivar')
        .setDescription('Apaga el sistema y borra el canal de creación')
        .addBooleanOption((o) =>
          o
            .setName('borrar_temporales')
            .setDescription('Borrar YA todos los canales temporales (con confirmación) en vez de esperar a que queden vacíos')
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('formato')
        .setDescription('Cambia el nombre de los canales temporales')
        .addStringOption((o) => o.setName('plantilla').setDescription('Usá {usuario} donde va el nombre. Ej: «🔊 Canal de {usuario}»').setMaxLength(90))
    )
    .addSubcommand((sc) => sc.setName('estado').setDescription('Muestra la configuración, los canales activos y el diagnóstico del sistema')),

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
      const permitirFallback = interaction.options.getBoolean('permitir_fallback') ?? false;
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        c.voz.categoriaId = categoria.id;
        if (permitirFallback) c.voz.fallbackCategoriaHub = true;
        else delete c.voz.fallbackCategoriaHub;
      });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { movidos, fallidos } = await voz.moverTemporalesACategoria(interaction.guild, categoria.id);
      const lineas = [`Categoría configurada: **${categoria.name}**.`, 'Los canales temporales de los usuarios se crean ahí.'];
      if (movidos.length) lineas.push(`📦 ${movidos.length} canal(es) ya existente(s) se movieron a la nueva categoría (conservando sus permisos).`);
      if (fallidos.length) {
        lineas.push(
          `⚠️ **${fallidos.length} canal(es) no se pudieron mover** (Discord los rechazó):` +
            fallidos.slice(0, 5).map((f) => `\n• ${f.canal.name} — \`${f.motivo}\``).join('') +
            (fallidos.length > 5 ? `\n• … y ${fallidos.length - 5} más.` : '')
        );
      }
      if (permitirFallback) {
        lineas.push('⚠️ Fallback **activado**: si la categoría falla, el bot intentará crear en la categoría del hub. Lo recomendable es revisar permisos y dejarlo apagado.');
      }
      return interaction.editReply({ embeds: [successEmbed(lineas.join('\n'))] });
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

    if (sub === 'limite') {
      const canales = interaction.options.getInteger('canales', true);
      setGuildConfig(interaction.guildId, (c) => {
        c.voz = c.voz || {};
        c.voz.limiteCanales = canales;
      });
      return interaction.reply({
        embeds: [successEmbed(`Límite fijado en **${canales}** canal(es) temporales. Si se alcanza, el bot avisa en el chat del hub y lo registra en los logs.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'desactivar') {
      const config = voz.vozDe(interaction.guildId);
      if (!config.hubId) {
        return interaction.reply({ embeds: [errorEmbed('El sistema no está activo.')], flags: MessageFlags.Ephemeral });
      }
      const borrarTemporales = interaction.options.getBoolean('borrar_temporales') ?? false;
      const temporales = Object.keys(voz.temporalesDe(interaction.guildId));

      // Confirmación: borrar N canales con gente adentro es destructivo.
      if (borrarTemporales && temporales.length > 0) {
        const fila = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('voz:admin:desactivar_borrar').setLabel(`Borrar todo (${temporales.length})`).setEmoji('🗑️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('voz:admin:desactivar_conservar').setLabel('Conservarlos').setEmoji('🛡️').setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({
          embeds: [
            errorEmbed(
              `Hay **${temporales.length} canal(es) temporales vivos**.\n` +
                'Si los borrás ahora, la gente queda en la calle. ¿Seguro? Elegí una opción.'
            ),
          ],
          components: [fila],
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await voz.desactivarSistema(interaction.guild, { borrarTemporales });
      const nota = borrarTemporales
        ? `🗑️ Se borraron **${res.borrados} de ${res.total}** canal(es) temporales y sus registros.`
        : 'Los canales temporales ya creados se borran solos al vaciarse.';
      return interaction.editReply({ embeds: [successEmbed(`Sistema desactivado. ${nota}`)] });
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
            plantilla ? `Formato actualizado: **${voz.nombreCanal(plantilla, 'Federico')}**` : `Volvimos al formato por defecto: **${voz.PLANTILLA_NOMBRE}**.`
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'estado') {
      const config = voz.vozDe(interaction.guildId);
      const guild = interaction.guild;
      const hub = config.hubId ? guild.channels.cache.get(config.hubId) : null;
      const categoria = config.categoriaId ? guild.channels.cache.get(config.categoriaId) : null;
      const temporales = Object.entries(voz.temporalesDe(guild.id));
      const bot = guild.members.me;
      const tope = voz.limiteCanales(guild.id);
      const bloqueos = Object.entries(config.bloqueos || {});

      // ---------- Diagnóstico (solo informa, no modifica nada) ----------
      const problemas = [];
      if (config.hubId && !hub) problemas.push('🔴 El canal hub fue **eliminado a mano**: volvé a activarlo con `/voz activar` o designá otro con `/voz hub`.');
      if (config.categoriaId && !categoria) problemas.push('🔴 La **categoría destino fue eliminada**: elegí otra con `/voz categoria`.');
      if (!bot?.permissions?.has(PermissionFlagsBits.ManageChannels)) problemas.push('🔴 Al bot le falta el permiso **Gestionar canales** en el server: no puede crear ni borrar canales.');
      if (!bot?.permissions?.has(PermissionFlagsBits.MoveMembers)) problemas.push('🔴 Al bot le falta **Mover miembros**: no puede meter a la gente en su canal ni expulsarla.');

      const fueraDeCategoria = [];
      const registrosMuertos = [];
      for (const [canalId] of temporales) {
        const canal = guild.channels.cache.get(canalId);
        if (!canal) {
          registrosMuertos.push(canalId);
          continue;
        }
        if (categoria && canal.parentId !== categoria.id) fueraDeCategoria.push(canal.name);
      }
      if (registrosMuertos.length) {
        problemas.push(`🟡 **${registrosMuertos.length} registro(s) huérfano(s)** (canales borrados a mano). Se limpian solos en la próxima creación.`);
      }
      if (fueraDeCategoria.length) {
        problemas.push(`🟡 **${fueraDeCategoria.length} canal(es) quedaron fuera de la categoría destino** (${fueraDeCategoria.slice(0, 3).join(', ')}${fueraDeCategoria.length > 3 ? '…' : ''}). Movelos con \`/voz categoria\`.`);
      }
      const destino = categoria ?? hub?.parent ?? null;
      if (destino && !bot?.permissionsIn(destino)?.has(PermissionFlagsBits.ManageChannels)) {
        problemas.push('🔴 El bot **no tiene permiso de crear canales en la categoría destino** (falta «Gestionar canales» para el rol del bot ahí).');
      }
      const ocupacion = temporales.length >= tope ? '🔴 **Límite de canales alcanzado**: nadie más puede crear hasta que se liberen.' : temporales.length >= Math.ceil(tope * 0.8) ? '🟡 Más del 80% del límite de canales en uso.' : '';
      if (ocupacion) problemas.push(ocupacion);

      const lista = temporales
        .map(([canalId, duenoId]) => {
          const canal = guild.channels.cache.get(canalId);
          return canal ? `• **${canal.name}** — dueño: <@${duenoId}> (${canal.members.size} adentro)` : null;
        })
        .filter(Boolean)
        .join('\n');

      const embed = brandEmbed({
        color: problemas.some((p) => p.startsWith('🔴')) ? 0xed4245 : 0x5865f2,
        title: '🎧 Canales de voz temporales',
        description:
          `**Estado:** ${hub ? '🟢 Activo' : '🔴 Inactivo'}\n` +
          `**Canal de creación:** ${hub ? hub.name : 'sin configurar'}\n` +
          `**Categoría destino:** ${categoria ? categoria.name : 'la del hub (sin configurar)'}\n` +
          `**Formato:** ${config.formato || voz.PLANTILLA_NOMBRE}\n` +
          `**Registros:** ${config.eventos || 'errores (por defecto)'}\n` +
          `**Contador en el nombre:** ${config.contador === false ? 'apagado' : 'prendido (por defecto)'}\n` +
          `**Límite de canales:** ${tope} (en uso: ${temporales.length}/${tope})\n` +
          `**Fallback a la categoría del hub:** ${voz.fallbackActivo(guild.id) ? 'activado' : 'apagado (recomendado)'}\n` +
          `**Bloqueos con vencimiento:** ${bloqueos.length ? bloqueos.map(([id, vence]) => `\n• <#${id}> — se reabre <t:${Math.floor(Number(vence) / 1000)}:R>`).join('') : 'ninguno'}\n\n` +
          `**Canales activos (${temporales.length}):**\n${lista || '*ninguno en este momento*'}` +
          (problemas.length ? `\n\n**🩺 Diagnóstico:**\n${problemas.join('\n')}` : '\n\n✅ Sin problemas operativos detectados.'),
      });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
};
