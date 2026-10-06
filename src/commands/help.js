const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { construirGuia, construirGuiaStaff, detalleDeComando, esPublico, CATEGORIAS_PUBLICAS } = require('../utils/guia');

// Orden en el que la guía pública presenta sus comandos (Información primero,
// Diversión al final). Discord deja 25 opciones de autocompletado como máximo y hay
// más comandos públicos que eso: con la casilla vacía se muestran primero los de las
// categorías y en ese orden; lo que no esté en ninguna categoría va después, alfabético.
// Sin esto, el orden alfabético puro dejaba afuera comandos como /top.
const DESTACADOS = new Map(CATEGORIAS_PUBLICAS.flatMap((c) => c.comandos).map((nombre, i) => [nombre, i]));
const { errorEmbed } = require('../utils/replies');
const { esStaff } = require('../utils/permisos');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Muestra la guía de TriggerBOT y sus comandos')
    .addSubcommand((sub) =>
      sub
        .setName('user')
        .setDescription('Guía de comandos para usuarios: qué podés usar y cómo funciona cada cosa')
        .addStringOption((o) => o.setName('comando').setDescription('Ver el detalle de un comando puntual').setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('staff')
        .setDescription('Guía completa de staff: moderación, configuración y comandos internos')
        .addStringOption((o) => o.setName('comando').setDescription('Ver el detalle de un comando puntual').setAutocomplete(true))
    ),
  // Sin setDefaultMemberPermissions en 'staff': el staff lo define el bot con
  // ManageGuild O los roles admin/mod/helper de /config (misma política que /config).
  // Discord ocultaría el comando a un helper configurado solo por rol, así que la
  // política interna de esStaff() es la única fuente de verdad para ambas opciones.
  // Autocompletado del nombre del comando: en la guía pública solo se ofrecen los
  // comandos que cualquiera puede usar; en la de staff, todos.
  async autocomplete(interaction) {
    const esStaffSub = interaction.options.getSubcommand() === 'staff';
    const tipeado = String(interaction.options.getFocused() ?? '').toLowerCase();
    // En la guía de staff va alfabético a secas: ahí no hay nada que destacar por encima
    // del resto y el que la usa sabe qué busca.
    const prioridad = (nombre) => (esStaffSub ? 0 : (DESTACADOS.get(nombre) ?? DESTACADOS.size));
    const opciones = [...interaction.client.commands.keys()]
      .filter((nombre) => esStaffSub || esPublico(interaction.client.commands.get(nombre)))
      .filter((nombre) => nombre.includes(tipeado))
      .sort((a, b) => prioridad(a) - prioridad(b) || a.localeCompare(b))
      .slice(0, 25)
      .map((nombre) => ({ name: `/${nombre}`, value: nombre }));
    await interaction.respond(opciones);
  },

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const pedido = interaction.options.getString('comando');

    if (sub === 'staff') {
      if (!esStaff(interaction)) {
        return interaction.reply({
          embeds: [errorEmbed('Esta parte de la guía es solo para staff.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (pedido) {
        const detalle = detalleDeComando(client, pedido);
        if (!detalle) {
          return interaction.reply({ embeds: [errorEmbed(`No existe el comando \`/${pedido}\`.`)], flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ embeds: [detalle], flags: MessageFlags.Ephemeral });
      }
      // La guía de staff es efímera: nadie más la ve, ni en canales públicos.
      return interaction.reply({ embeds: [construirGuiaStaff(client)], flags: MessageFlags.Ephemeral });
    }

    // Subcomando 'user'.
    if (pedido) {
      // Un comando de staff no se detalla en la guía pública (se filtra en el autocompletado,
      // pero el texto se puede escribir a mano).
      const publicoPedido = esPublico(client.commands.get(pedido));
      if (!publicoPedido) {
        return interaction.reply({
          embeds: [errorEmbed(`No encontré un comando público llamado \`/${pedido}\`.`)],
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({ embeds: [detalleDeComando(client, pedido)], flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ embeds: [construirGuia(client)] });
  },
};
