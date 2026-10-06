// /bienvenida test — previsualiza la bienvenida que reciben los miembros nuevos.
//
// Configurar la bienvenida a ciegas es cómo se descubren los errores: el texto con
// {usuario} mal escrito, el canal sin permiso de escritura o el autorol que ya no existe
// solo se notan cuando entra alguien de verdad, y para entonces el bot ya saludó mal a
// los que entraron. Este comando arma el embed REAL (el mismo que publica
// events/guildMemberAdd.js) y lo muestra en efímero, con el estado de la configuración.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../store');
const { brandEmbed, errorEmbed, successEmbed, COLORS } = require('../utils/replies');
const { exigirStaff } = require('../utils/permisos');
const { embedBienvenida } = require('../events/guildMemberAdd');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bienvenida')
    .setDescription('Previsualiza la bienvenida que reciben los miembros nuevos')
    .addSubcommand((sc) =>
      sc
        .setName('test')
        .setDescription('Muestra el mensaje de bienvenida tal como lo verían los nuevos')
        .addBooleanOption((o) =>
          o
            .setName('enviar')
            .setDescription('Enviarlo de verdad al canal configurado (por defecto solo lo previsualiza)')
        )
    ),

  async execute(interaction) {
    if (!(await exigirStaff(interaction, PermissionFlagsBits.ManageGuild, 'La bienvenida se configura con /config: es solo para el staff.'))) return;

    const guild = interaction.guild;
    const config = getGuildConfig(guild.id);
    const channelId = config.welcome?.channelId;
    const canal = channelId ? guild.channels.cache.get(channelId) ?? null : null;

    if (!channelId) {
      return interaction.reply({
        embeds: [
          errorEmbed(
            'Este servidor todavía no tiene un canal de bienvenida.\nSe elige desde `/config` → **Bienvenida**.',
            'Falta configurarla'
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // La previsualización usa a quien pide la prueba: es la única persona que tenemos a
    // mano y deja ver cómo queda el nombre y el avatar en el mensaje. Se le pasa el
    // servidor explícito porque lo que se arma es un "miembro de ejemplo", no un ingreso.
    const ejemplo = { id: interaction.user.id, user: interaction.member?.user ?? interaction.user, guild };
    const preview = embedBienvenida(config, ejemplo);

    // Estado REAL de lo que va a pasar cuando entre alguien (no lo que debería pasar):
    // son los tres avisos que hoy solo quedan en la consola del bot.
    const permisos = canal?.permissionsFor?.(guild.members.me);
    const puedeEscribir = Boolean(canal) && (!permisos || permisos.has(PermissionFlagsBits.SendMessages));
    const rol = config.autorole ? guild.roles.cache.get(config.autorole) : null;
    const avisos = [];
    if (!canal) avisos.push(`El canal configurado ya no existe (\`${channelId}\`): elegí otro desde \`/config\`.`);
    else if (!puedeEscribir) avisos.push(`Me falta el permiso de **Enviar mensajes** en <#${canal.id}>: el mensaje no va a salir.`);
    if (config.autorole && !rol) avisos.push('El rol de autorol configurado ya no existe: los nuevos no van a recibir ningún rol.');

    // Con el permiso de enviar la prueba de verdad: se publica el MISMO embed (para verlo
    // renderizado en el canal, no en gris) con una línea que aclara que es una prueba y
    // sin mencionar a nadie (el {usuario} de la prueba es quien la pidió).
    if (interaction.options.getBoolean('enviar') === true) {
      if (!canal) {
        return interaction.reply({ embeds: [errorEmbed(avisos[0], 'No se pudo enviar')], flags: MessageFlags.Ephemeral });
      }
      if (!puedeEscribir) {
        return interaction.reply({
          embeds: [errorEmbed(`No puedo escribir en <#${canal.id}>: revisá mis permisos en ese canal.`, 'No se pudo enviar')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const enviado = await canal
        .send({
          content: `> **Prueba de bienvenida** pedida por ${interaction.user}`,
          embeds: [preview],
          allowedMentions: { parse: [] },
        })
        .then(() => true)
        .catch(() => false);

      if (!enviado) {
        return interaction.reply({
          embeds: [errorEmbed(`Discord rechazó el envío en <#${canal.id}>. Revisá mis permisos ahí.`, 'No se pudo enviar')],
          flags: MessageFlags.Ephemeral,
        });
      }

      return interaction.reply({
        embeds: [
          successEmbed(
            `Envié la bienvenida de prueba a <#${canal.id}>. Es el mismo mensaje que recibe alguien que entra (sin mencionar a nadie).`,
            'Prueba enviada'
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      embeds: [
        preview,
        brandEmbed({
          color: avisos.length ? COLORS.warn : COLORS.success,
          title: 'Estado de la bienvenida',
          description: 'El mensaje de arriba es el que se publica. Acá usa tu nombre y tu avatar: cuando entra alguien se usan los suyos.',
          fields: [
            { name: 'Canal', value: canal ? `<#${canal.id}>` : `\`${channelId}\` (ya no existe)`, inline: true },
            { name: 'Mensaje', value: config.welcome?.message ? 'personalizado' : 'por defecto', inline: true },
            { name: 'Autorol', value: config.autorole ? (rol ? `<@&${rol.id}>` : 'el rol ya no existe') : 'sin configurar', inline: true },
            ...(avisos.length ? [{ name: 'A revisar', value: avisos.map((a) => `• ${a}`).join('\n'), inline: false }] : []),
          ],
          footer: 'TriggerBOT • se configura en /config → Bienvenida • enviar:true para publicarlo de verdad',
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
