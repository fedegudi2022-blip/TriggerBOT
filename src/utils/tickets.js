// Sistema de tickets de soporte: un panel con botón en un canal; al apretarlo se crea
// un canal privado visible solo por el usuario y el staff. Al cerrarlo se genera un
// transcript .txt con la conversación, se manda a los logs y se borra el canal.
//
// Config (config.tickets en store.js): { categoriaId, canalLogs, mensajes }
// Estado de cada ticket (en el topic del canal): guildId:userId:numero
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { brandEmbed } = require('./replies');
const { getGuildConfig, setGuildConfig } = require('../store');

function configDe(guildId) {
  return getGuildConfig(guildId).tickets ?? {};
}

// Contador de tickets por server (para el número #001, #002...).
function siguienteNumero(guildId) {
  let n = 1;
  setGuildConfig(guildId, (c) => {
    c.tickets = c.tickets || {};
    c.tickets.contador = (c.tickets.contador || 0) + 1;
    n = c.tickets.contador;
  });
  return n;
}

function esStaff(member) {
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const config = getGuildConfig(member.guild.id);
  return ['admin', 'mod', 'helper'].some((nivel) => member.roles.cache.has(config[`${nivel}Role`]));
}

function botonesTicket() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:cerrar').setLabel('Cerrar ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
}

// Bloqueo anti-carrera: dos clics casi simultáneos pueden pasar ambos el chequeo de
// "ya tenés un ticket" antes de que ninguno creara el canal → dos tickets por persona.
// Mientras se crea el canal, el userId queda en este Set y el segundo intento sale.
const abriendoAhora = new Set();

// Abre un ticket para el usuario. Devuelve el canal creado o { error }.
async function abrirTicket(interaction, motivo) {
  const guild = interaction.guild;
  const user = interaction.user;
  const config = configDe(guild.id);
  const raiz = getGuildConfig(guild.id);

  const claveAbriendo = `${guild.id}:${user.id}`;
  if (abriendoAhora.has(claveAbriendo)) {
    return { error: 'Ya estoy abriendo tu ticket, esperá unos segundos...' };
  }
  abriendoAhora.add(claveAbriendo);
  try {
    return await abrirTicketInterno(interaction, motivo, { config, raiz });
  } finally {
    abriendoAhora.delete(claveAbriendo);
  }
}

async function abrirTicketInterno(interaction, motivo, { config, raiz }) {
  const guild = interaction.guild;
  const user = interaction.user;

  // Un ticket abierto por persona (los canales llevan el userId en el topic).
  const existente = guild.channels.cache.find((c) => c.topic?.startsWith(`${guild.id}:${user.id}:`));
  if (existente) return { error: `Ya tenés un ticket abierto: <#${existente.id}>` };

  const numero = siguienteNumero(guild.id);
  const numeroTxt = String(numero).padStart(3, '0');

  const overrides = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
    {
      id: interaction.client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels],
    },
  ];
  // El staff entra por roles configurados; sin config, quien tenga ManageGuild lo ve igual.
  for (const rolId of [raiz.adminRole, raiz.modRole, raiz.helperRole].filter(Boolean)) {
    if (guild.roles.cache.has(rolId)) {
      overrides.push({
        id: rolId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
      });
    }
  }

  const canal = await guild.channels.create({
    name: `ticket-${numeroTxt}`,
    type: ChannelType.GuildText,
    parent: config.categoriaId && guild.channels.cache.has(config.categoriaId) ? config.categoriaId : null,
    permissionOverwrites: overrides,
    topic: `${guild.id}:${user.id}:${numeroTxt}`,
    reason: `Ticket de ${user.tag}`,
  });

  await canal.send({
    content: `${user}, acá está tu ticket. El staff te va a responder a la brevedad.`,
    embeds: [
      brandEmbed({
        color: 0x5865f2,
        title: `🎫 Ticket #${numeroTxt}`,
        description: `**Usuario:** ${user} (\`${user.tag}\`)\n**Motivo:** ${motivo || 'sin especificar'}`,
        footer: 'TriggerBOT • usá el botón para cerrar cuando esté resuelto',
      }),
    ],
    components: [botonesTicket()],
  });

  loguear(guild, {
    color: 0x57f287,
    title: '🎫 Ticket abierto',
    description: `${user} abrió el ticket **#${numeroTxt}** → <#${canal.id}>`,
  });

  return { canal, numero };
}

// Cierra el ticket del canal actual: transcript, DM, log y borra el canal (30 s de gracia).
async function cerrarTicket(interaction, cerradoPor) {
  const canal = interaction.channel;
  const [, userId, numero] = canal.topic?.split(':') ?? [];
  const guild = canal.guild;

  await canal.send({ embeds: [brandEmbed({ color: 0xfee75c, title: '📦 Generando transcript…', description: `El canal se cierra en un momento, ${cerradoPor}.` })] }).catch(() => {});

  // Transcript: todos los mensajes del canal, en orden (de a 100 por fetch).
  // Tope práctico: 50.000 mensajes (500 páginas). Un ticket normal nunca llega;
  // si llegara, se corta y el conteo del aviso refleja lo guardado.
  const lineas = [];
  let antes = null;
  for (let vuelta = 0; vuelta < 500; vuelta++) {
    const lote = await canal.messages.fetch({ limit: 100, before: antes }).catch(() => null);
    if (!lote?.size) break;
    for (const m of lote.values()) {
      const stamp = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
      const adjuntos = m.attachments.size ? `\n   [adjunto: ${[...m.attachments.values()].map((a) => a.url).join(', ')}]` : '';
      lineas.push(`[${stamp}] ${m.author.tag}: ${m.content || '(sin texto)'}${adjuntos}`);
    }
    antes = lote.last().id;
    if (lote.size < 100) break;
  }
  lineas.reverse();

  const cabecera =
    `Transcript del ticket #${numero} — ${guild.name}\n` +
    `Canal: #${canal.name} · Cerrado por: ${cerradoPor.tag} · ${new Date().toISOString()}\n` +
    `Mensajes: ${lineas.length}\n` +
    '='.repeat(60) + '\n\n';
  const transcript = Buffer.from(cabecera + lineas.join('\n'), 'utf8');
  const nombreArchivo = `transcript-${canal.name}.txt`;

  await canal.send({
    embeds: [
      brandEmbed({
        color: 0xed4245,
        title: `🔒 Ticket cerrado por ${cerradoPor.tag}`,
        description: `Se guardó un transcript con **${lineas.length}** mensajes. El canal se borra en **30 segundos**.`,
      }),
    ],
  }).catch(() => {});

  // Copia al canal de logs de tickets (o logs/avisos general como fallback).
  const config = configDe(guild.id);
  const raiz = getGuildConfig(guild.id);
  const canalLogs = guild.channels.cache.get(config.canalLogs || raiz.logs || raiz.avisosChannel);
  if (canalLogs) {
    await canalLogs
      .send({
        embeds: [
          brandEmbed({
            color: 0xfee75c,
            title: `🔒 Ticket #${numero} cerrado`,
            description: `**Abierto por:** <@${userId}>\n**Cerrado por:** ${cerradoPor}\n**Mensajes:** ${lineas.length}`,
          }),
        ],
        files: [{ attachment: transcript, name: nombreArchivo }],
      })
      .catch(() => {});
  }

  // Copia por DM al usuario del ticket.
  if (userId) {
    const duenio = await guild.client.users.fetch(userId).catch(() => null);
    if (duenio) {
      await duenio
        .send({
          embeds: [brandEmbed({ color: 0x5865f2, title: `🎫 Tu ticket #${numero} fue cerrado`, description: `Gracias por contactar al staff de **${guild.name}**. Te dejamos la conversación por si la necesitás.` })],
          files: [{ attachment: transcript, name: nombreArchivo }],
        })
        .catch(() => {});
    }
  }

  loguear(guild, {
    color: 0xfee75c,
    title: `🔒 Ticket #${numero} cerrado`,
    description: `Por ${cerradoPor} · transcript enviado a logs y al DM del usuario.`,
  });

  await new Promise((r) => {
    setTimeout(r, 30_000);
  });
  await canal.delete(`Ticket cerrado por ${cerradoPor.tag}`).catch(() => {});
}

// ---------- Logs ----------
function loguear(guild, { color, title, description }) {
  const { logEvent } = require('./log');
  logEvent(guild, { color, title, description });
}

// ---------- Panel público con botón ----------
function panel(guild) {
  const config = configDe(guild.id);
  return {
    embeds: [
      brandEmbed({
        color: 0x5865f2,
        title: '🎫 Soporte',
        description:
          config.mensajes ||
          '¿Necesitás hablar con el staff? Abrí un ticket con el botón de abajo: se crea un canal privado solo para vos y el equipo.',
        footer: 'TriggerBOT • un ticket por persona',
      }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket:abrir').setLabel('Abrir ticket').setEmoji('📨').setStyle(ButtonStyle.Primary)
      ),
    ],
  };
}

// ---------- Handlers de botones (conectados desde index.js) ----------

async function manejarBotonTicket(interaction) {
  const accion = interaction.customId.split(':')[1];

  if (accion === 'abrir') {
    const modal = new ModalBuilder().setCustomId('ticket:modal').setTitle('Abrir ticket de soporte');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('motivo').setLabel('Contáanos brevemente qué pasa').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }

  if (accion === 'cerrar') {
    const canal = interaction.channel;
    const duenioId = canal.topic?.split(':')[1];
    const esDuenio = interaction.user.id === duenioId;
    if (!esDuenio && !esStaff(interaction.member)) {
      return interaction.reply({ content: 'Solo el dueño del ticket o el staff pueden cerrarlo.', flags: MessageFlags.Ephemeral });
    }
    await interaction.reply({ content: '🔒 Cerrando el ticket…', flags: MessageFlags.Ephemeral });
    await cerrarTicket(interaction, interaction.user);
  }
}

async function manejarModalTicket(interaction) {
  if (interaction.customId !== 'ticket:modal') return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const motivo = interaction.fields.getTextInputValue('motivo');
  const resultado = await abrirTicket(interaction, motivo);
  if (resultado.error) {
    return interaction.editReply({ content: `⚠️ ${resultado.error}` });
  }
  await interaction.editReply({ content: `✅ Tu ticket quedó abierto en ${resultado.canal}.` });
}

module.exports = { abrirTicket, cerrarTicket, panel, configDe, esStaff, manejarBotonTicket, manejarModalTicket };
