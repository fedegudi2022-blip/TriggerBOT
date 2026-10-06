const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { logAction } = require('../utils/modlog');
const { errorEmbed, accionEmbed, nombreDe, COLORS } = require('../utils/replies');
const { quiereSilencioso, diferir, intentar } = require('../utils/acciones');
const { exigirStaff } = require('../utils/permisos');
const { pedir } = require('../utils/confirmaciones');
const { getGuildConfig, setGuildConfig } = require('../store');

// ---------- Estado previo del canal ----------
// Desbloquear con `SendMessages: null` BORRABA el valor en vez de restaurarlo: un canal
// que negaba el envío a propósito (solo lectura) o que lo permitía explícitamente
// quedaba como si nadie hubiera configurado nada ahí. Guardamos qué había ANTES de
// bloquear, en la config del servidor, para poder devolverlo. Sobrevive reinicios y
// también el desbloqueo hecho a mano con `/lockdown accion:desbloquear`.
const CLAVE = 'lockdowns';

function estadoActual(channel, guild) {
  const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
  if (!overwrite) return { existia: false, valor: 'neutral' };
  const flag = PermissionFlagsBits.SendMessages;
  return { existia: true, valor: overwrite.allow.has(flag) ? 'allow' : overwrite.deny.has(flag) ? 'deny' : 'neutral' };
}

function guardarEstado(guildId, channelId, estado) {
  setGuildConfig(guildId, (config) => {
    config[CLAVE] = config[CLAVE] || {};
    config[CLAVE][channelId] = { ...estado, at: Date.now() };
  });
}

function olvidarEstado(guildId, channelId) {
  setGuildConfig(guildId, (config) => {
    if (!config[CLAVE]?.[channelId]) return;
    delete config[CLAVE][channelId];
    if (!Object.keys(config[CLAVE]).length) delete config[CLAVE];
  });
}

// Devuelve el canal a como estaba. Retorna el valor restaurado, o 'desconocido' cuando
// el bloqueo es anterior a esta versión y no hay nada guardado que devolver.
async function restaurarEstado(channel, guild, firma) {
  const estado = getGuildConfig(guild.id)[CLAVE]?.[channel.id];
  if (!estado) {
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }, { reason: firma });
    return 'desconocido';
  }
  if (estado.valor === 'neutral' && !estado.existia) {
    // No había overwrite para @everyone: se borra el que creó el bloqueo en vez de
    // dejar uno vacío colgado.
    await channel.permissionOverwrites.delete(guild.roles.everyone, firma);
  } else {
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: estado.valor === 'neutral' ? null : estado.valor === 'allow' },
      { reason: firma }
    );
  }
  olvidarEstado(guild.id, channel.id);
  return estado.valor;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Bloquea o desbloquea el envío de mensajes en un canal')
    .addStringOption((o) =>
      o
        .setName('accion')
        .setDescription('Qué hacer con el canal')
        .setRequired(true)
        .addChoices({ name: 'Bloquear', value: 'bloquear' }, { name: 'Desbloquear', value: 'desbloquear' })
    )
    .addChannelOption((o) =>
      o
        .setName('canal')
        .setDescription('Canal afectado (por defecto, el canal actual)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addStringOption((o) => o.setName('razon').setDescription('Motivo del bloqueo').setMaxLength(500))
    .addBooleanOption((o) => o.setName('silencioso').setDescription('Mostrar la confirmación solo a vos')),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ManageChannels))) return;

    const accion = interaction.options.getString('accion', true);
    const channel = interaction.options.getChannel('canal') ?? interaction.channel;
    const reason = interaction.options.getString('razon');
    const silencioso = quiereSilencioso(interaction);
    const guild = interaction.guild;
    const bloquear = accion === 'bloquear';

    if (!channel.manageable) {
      return interaction.reply({
        embeds: [errorEmbed(`No tengo permiso para gestionar <#${channel.id}>. Revisá mis permisos en ese canal.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Aplica el cambio de permiso y devuelve el resultado real + el embed.
    const aplicar = async (autor, hacerBloqueo) => {
      const firma = reason ? `${reason} — por ${nombreDe(autor.user)}` : `por ${nombreDe(autor.user)}`;
      let restaurado = null;

      // El estado previo se guarda ANTES de tocar el canal: es lo único que permite
      // devolverlo después (incluso si el desbloqueo lo hace otro moderador).
      if (hacerBloqueo) guardarEstado(guild.id, channel.id, estadoActual(channel, guild));

      const resultado = await intentar(hacerBloqueo ? 'Discord rechazó el bloqueo' : 'Discord rechazó el desbloqueo', async () => {
        if (hacerBloqueo) {
          await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: firma });
          return;
        }
        restaurado = await restaurarEstado(channel, guild, firma);
      });

      // Si Discord rechazó el bloqueo el canal nunca cambió: una entrada guardada solo
      // haría que el próximo desbloqueo "restaure" algo que ya estaba así.
      if (hacerBloqueo && !resultado.ok) olvidarEstado(guild.id, channel.id);

      const etiqueta = hacerBloqueo ? 'Bloqueo de canal (lockdown)' : 'Desbloqueo de canal';
      const caso = logAction(guild, {
        action: resultado.ok ? etiqueta : `${etiqueta} — rechazado`,
        color: resultado.ok ? (hacerBloqueo ? COLORS.error : COLORS.success) : COLORS.warn,
        target: { raw: `Canal ${channel} (\`#${channel.name}\`)` },
        moderator: autor.user,
        reason,
        extra:
          `Canal: <#${channel.id}>` +
          (resultado.ok ? '' : ` — ${resultado.error}`) +
          (restaurado === 'desconocido' ? ' — sin estado previo guardado' : ''),
      });

      if (!resultado.ok) {
        return {
          ok: false,
          embeds: [
            errorEmbed(`No pude ${hacerBloqueo ? 'bloquear' : 'desbloquear'} <#${channel.id}>.\n> ${resultado.error}`, 'La acción no se aplicó'),
          ],
        };
      }

      return {
        ok: true,
        embeds: [
          accionEmbed({
            color: hacerBloqueo ? COLORS.error : COLORS.success,
            titulo: hacerBloqueo ? 'Canal bloqueado' : 'Canal desbloqueado',
            detalle: hacerBloqueo
              ? `**${channel}** quedó bloqueado: nadie de @everyone puede escribir hasta que lo desbloqueen.`
              : `**${channel}** fue desbloqueado: ya se puede volver a escribir.`,
            motivo: reason,
            caso,
            moderador: autor.member?.displayName ?? autor.user.username,
            campos:
              restaurado === 'desconocido'
                ? [
                    {
                      name: 'Ojo',
                      value:
                        'No tenía guardado el estado previo de este canal (el bloqueo es anterior a esta versión), ' +
                        'así que quedó con el valor por defecto. Si era un canal de solo lectura, revisá sus permisos.',
                      inline: false,
                    },
                  ]
                : [],
            footer: hacerBloqueo ? 'usá Deshacer o /lockdown accion:desbloquear' : undefined,
          }),
        ],
      };
    };

    // Desbloquear no es destructivo: se aplica directo, como antes.
    if (!bloquear) {
      await diferir(interaction, silencioso);
      const salida = await aplicar(interaction, false);
      return interaction.editReply({ embeds: salida.embeds });
    }

    // Cerrar un canal afecta a todos: se confirma antes de tocarlo.
    return pedir(interaction, {
      titulo: 'Confirmar bloqueo de canal',
      color: COLORS.error,
      silencioso,
      deshacerLabel: 'Deshacer (desbloquear)',
      detalle: `Vas a cerrar **${channel}**: nadie de @everyone podrá escribir hasta que se desbloquee.\n**Motivo:** ${reason || '*no especificado*'}`,
      ejecutar: (btn) => aplicar(btn, true),
      deshacer: (btn) => aplicar(btn, false),
    });
  },
};
