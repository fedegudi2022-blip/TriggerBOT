// /sanciones — quién está silenciado AHORA en este servidor.
//
// Faltaba el estado actual: /warnings y /casos miran el historial de una persona, y nada
// contestaba "¿quién está callado en este momento?". Son dos mecanismos distintos y se
// muestran separados porque se levantan distinto: el rol Silenciado se quita con /unmute,
// y el silencio temporal vence solo (o se levanta con /timeout → Quitarlo ahora).
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../store');
const { brandEmbed, successEmbed, miles, marcaTiempo, COLORS } = require('../utils/replies');
const { exigirStaff } = require('../utils/permisos');

const MAX_LISTA = 20; // por campo: más renglones no se leen
// Un servidor enorme no se descarga entero por un comando: si pasa de esto, se avisa que el
// listado puede estar incompleto en vez de pagar la descarga completa en cada uso.
const MAX_DESCARGA = 5000;

// Lista con tope: dice cuántos quedaron afuera en lugar de cortar en silencio.
function listar(items, linea) {
  const visibles = items.slice(0, MAX_LISTA);
  const resto = items.length - visibles.length;
  return visibles.map(linea).join('\n') + (resto > 0 ? `\n*…y ${resto} más.*` : '');
}

// Nombre con su mención: en una lista de sanciones hay que poder ver de quién se habla.
const etiqueta = (miembro) => `**${miembro.displayName ?? miembro.user?.username ?? miembro.id}** (${miembro})`;

module.exports = {
  data: new SlashCommandBuilder().setName('sanciones').setDescription('Quién está silenciado ahora en este servidor (staff)'),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ModerateMembers, 'Ver las sanciones activas es solo para el staff.'))) return;

    const guild = interaction.guild;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // La caché de miembros puede estar incompleta (el bot acaba de arrancar): sin esto el
    // listado mentiría por omisión. Si la descarga falla, se dice en el resultado.
    const faltan = guild.memberCount - guild.members.cache.size;
    let completo = true;
    if (faltan > 0 && guild.memberCount <= MAX_DESCARGA) {
      completo = await guild.members
        .fetch()
        .then(() => true)
        .catch(() => false);
    } else if (faltan > 0) {
      completo = false;
    }

    const ahora = Date.now();
    const muteRole = getGuildConfig(guild.id).muteRole;
    const miembros = [...guild.members.cache.values()];

    const conRol = muteRole
      ? miembros.filter((m) => m.roles?.cache?.has?.(muteRole)).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), 'es'))
      : [];
    const conTimeout = miembros
      .filter((m) => (m.communicationDisabledUntilTimestamp ?? 0) > ahora)
      .sort((a, b) => a.communicationDisabledUntilTimestamp - b.communicationDisabledUntilTimestamp);

    if (!conRol.length && !conTimeout.length) {
      return interaction.editReply({
        embeds: [
          successEmbed(
            completo
              ? 'Nadie tiene el rol Silenciado ni un silencio temporal activo.'
              : 'Nadie de los miembros que pude revisar tiene el rol Silenciado ni un silencio temporal activo.',
            'Sin sanciones activas'
          ),
        ],
      });
    }

    const campos = [];
    if (conRol.length) {
      campos.push({ name: `Rol Silenciado (${conRol.length})`, value: listar(conRol, etiqueta), inline: false });
    }
    if (conTimeout.length) {
      campos.push({
        name: `Silencio temporal (${conTimeout.length})`,
        // Del que vence primero al último: es el orden en el que se van a liberar.
        value: listar(conTimeout, (m) => `${etiqueta(m)} — hasta ${marcaTiempo(m.communicationDisabledUntilTimestamp)}`),
        inline: false,
      });
    }

    const embed = brandEmbed({
      color: COLORS.warn,
      title: 'Sanciones activas',
      description: `${miles(conRol.length)} con rol Silenciado · ${miles(conTimeout.length)} con silencio temporal.`,
      fields: campos,
      footer: completo
        ? 'TriggerBOT • /unmute quita el rol · en /timeout, «Quitarlo ahora» levanta el temporal'
        : 'TriggerBOT • ojo: no pude revisar la lista completa de miembros, puede faltar gente',
    });

    return interaction.editReply({ embeds: [embed] });
  },
};
