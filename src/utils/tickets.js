// Sistema de tickets de soporte: un panel con botón en un canal; al apretarlo se crea
// un canal privado visible solo por el usuario y el staff. Al cerrarlo se genera un
// transcript .txt con la conversación, se manda a los logs y se borra el canal.
//
// Config (config.tickets en store.js): { categoriaId, canalLogs, mensajes }
// Estado de cada ticket (en el topic del canal): guildId:userId:numero
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { nombreDe, brandEmbed, COLORS } = require('./replies');
const { getGuildConfig, setGuildConfig } = require('../store');
const { autorizadoDe } = require('./permisos');
const crearLogger = require('../logger');

const log = crearLogger('tickets');

function configDe(guildId) {
  return getGuildConfig(guildId).tickets ?? {};
}

// Límite de adjunto de Discord (8 MiB sin boosts). Dejamos margen: si el transcript
// lo supera, se parte en varios archivos en vez de que el envío falle en silencio.
const LIMITE_ADJUNTO_BYTES = 7_800_000;

// Parte un transcript en archivos de a lo sumo LIMITE_ADJUNTO_BYTES, cortando por
// línea y numerando las partes. Devuelve [{ attachment, name }] listos para `files`.
function dividirTranscript(cabecera, lineas, nombreBase) {
  const partes = [];
  let actual = cabecera;
  let bytes = Buffer.byteLength(actual, 'utf8');
  for (const linea of lineas) {
    const lineaBytes = Buffer.byteLength(linea, 'utf8') + 1;
    if (bytes + lineaBytes > LIMITE_ADJUNTO_BYTES && actual !== cabecera) {
      partes.push(actual);
      actual = '';
      bytes = 0;
    }
    actual += linea + '\n';
    bytes += lineaBytes;
  }
  if (actual) partes.push(actual);
  if (!partes.length) partes.push(cabecera);

  const total = partes.length;
  return partes.map((texto, i) => ({
    attachment: Buffer.from((total > 1 ? `# Transcript — parte ${i + 1}/${total}\n` : '') + texto, 'utf8'),
    name: total > 1 ? nombreBase.replace(/\.txt$/, `-parte-${i + 1}.txt`) : nombreBase,
  }));
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
  return autorizadoDe(member.guild, member, PermissionFlagsBits.ManageGuild);
}

function botonesTicket() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:cerrar').setLabel('Cerrar ticket').setStyle(ButtonStyle.Danger)
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
    reason: `Ticket de ${nombreDe(user)}`,
  });

  await canal.send({
    content: `${user}, acá está tu ticket. El staff te va a responder a la brevedad.`,
    embeds: [
      brandEmbed({
        color: COLORS.info,
        title: `Ticket #${numeroTxt}`,
        description: `**Usuario:** ${user} (\`${nombreDe(user)}\`)\n**Motivo:** ${motivo || 'sin especificar'}`,
        footer: 'TriggerBOT • usá el botón para cerrar cuando esté resuelto',
      }),
    ],
    components: [botonesTicket()],
  });

  loguear(guild, {
    color: COLORS.success,
    title: 'Ticket abierto',
    description: `${user} abrió el ticket **#${numeroTxt}** → <#${canal.id}>`,
  });

  return { canal, numero };
}

// Cierra el ticket del canal actual: transcript, DM, log y borra el canal (30 s de gracia).
async function cerrarTicket(interaction, cerradoPor) {
  const canal = interaction.channel;
  const [, userId, numero] = canal.topic?.split(':') ?? [];
  const guild = canal.guild;

  await canal.send({ embeds: [brandEmbed({ color: COLORS.warn, title: 'Generando transcript…', description: `El canal se cierra en un momento, ${cerradoPor}.` })] }).catch(() => {});

  // Transcript: todos los mensajes del canal, en orden (de a 100 por fetch).
  // Tope práctico: 50.000 mensajes (500 páginas). Un ticket normal nunca llega.
  // Si un fetch falla o la conversación es más larga que el tope, el transcript
  // queda marcado como INCOMPLETO y no se borra el canal (ver más abajo).
  const MAX_PAGINAS = 500;
  const lineas = [];
  let antes = null;
  let parcial = false; // un fetch falló a mitad: no sabemos si faltan mensajes
  let truncado = false; // se alcanzó el tope de páginas guardando solo una parte
  for (let vuelta = 0; vuelta < MAX_PAGINAS; vuelta++) {
    let lote;
    try {
      lote = await canal.messages.fetch({ limit: 100, before: antes });
    } catch (error) {
      parcial = true;
      log.warn('No se pudo leer un lote del transcript', error, { canal: canal.id });
      break;
    }
    if (!lote?.size) break;
    for (const m of lote.values()) {
      const stamp = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
      const adjuntos = m.attachments.size ? `\n   [adjunto: ${[...m.attachments.values()].map((a) => a.url).join(', ')}]` : '';
      lineas.push(`[${stamp}] ${nombreDe(m.author)}: ${m.content || '(sin texto)'}${adjuntos}`);
    }
    antes = lote.last().id;
    if (lote.size < 100) break;
    if (vuelta === MAX_PAGINAS - 1) truncado = true; // quedaba más y cortamos
  }
  lineas.reverse();
  const integro = !parcial && !truncado;

  const cabecera =
    `Transcript del ticket #${numero} — ${guild.name}\n` +
    `Canal: #${canal.name} · Cerrado por: ${nombreDe(cerradoPor)} · ${new Date().toISOString()}\n` +
    `Mensajes: ${lineas.length}` +
    (integro ? '' : `  ⚠️ INCOMPLETO (${parcial ? 'falló la lectura de mensajes' : 'se superó el tope de mensajes'})`) +
    '\n' +
    '='.repeat(60) + '\n\n';
  const nombreArchivo = `transcript-${canal.name}.txt`;
  const partes = dividirTranscript(cabecera, lineas, nombreArchivo);

  const config = configDe(guild.id);
  const raiz = getGuildConfig(guild.id);
  const canalLogs = guild.channels.cache.get(config.canalLogs || raiz.logs || raiz.avisosChannel);

  // 1) Copia al canal de logs (o logs/avisos general como fallback). Es el requisito
  //    para poder borrar el canal: si no está configurado o algún envío falla, el
  //    transcript NO quedó a salvo.
  let guardadoEnLogs = false;
  if (canalLogs) {
    guardadoEnLogs = true;
    for (let i = 0; i < partes.length; i++) {
      const ok = await canalLogs
        .send({
          embeds:
            i === 0
              ? [
                  brandEmbed({
                    color: COLORS.warn,
                    title: `Ticket #${numero} cerrado`,
                    description:
                      `**Abierto por:** <@${userId}>\n**Cerrado por:** ${cerradoPor}\n**Mensajes:** ${lineas.length}` +
                      (integro ? '' : '\n⚠️ **Transcript incompleto**'),
                  }),
                ]
              : undefined,
          files: [partes[i]],
        })
        .then(() => true)
        .catch((error) => {
          log.warn('No se pudo enviar una parte del transcript a logs', error, { canal: canalLogs.id, parte: i + 1 });
          return false;
        });
      if (!ok) guardadoEnLogs = false;
    }
  }

  // 2) Copia por DM al usuario del ticket (mejor esfuerzo: no decide el cierre).
  if (userId) {
    const duenio = await guild.client.users.fetch(userId).catch(() => null);
    if (duenio) {
      for (let i = 0; i < partes.length; i++) {
        await duenio
          .send({
            embeds:
              i === 0
                ? [
                    brandEmbed({
                      color: COLORS.info,
                      title: `Tu ticket #${numero} fue cerrado`,
                      description:
                        `Gracias por contactar al staff de **${guild.name}**. Te dejamos la conversación por si la necesitás.` +
                        (integro ? '' : '\n⚠️ El transcript quedó incompleto.'),
                    }),
                  ]
                : undefined,
            files: [partes[i]],
          })
          .catch(() => {});
      }
    }
  }

  // 3) Solo se borra el canal si el transcript ÍNTEGRO quedó guardado en logs. Si
  //    no, se conserva la conversación y se avisa al staff para que reintente.
  if (!integro || !guardadoEnLogs) {
    const motivo = !integro
      ? parcial
        ? 'no pude leer todos los mensajes del canal'
        : 'la conversación supera el tope de mensajes que puedo guardar de una vez'
      : canalLogs
        ? `no pude enviar el transcript a <#${canalLogs.id}>`
        : 'no hay un canal de logs configurado para tickets (`/ticket logs`)';
    await canal
      .send({
        embeds: [
          brandEmbed({
            color: COLORS.error,
            title: '⚠️ No cerré el ticket',
            description:
              `No pude guardar el transcript completo: ${motivo}.\n` +
              '**Este canal no se borra** para no perder la conversación. Arreglá el problema y volvé a cerrar el ticket.',
          }),
        ],
      })
      .catch(() => {});
    loguear(guild, {
      color: COLORS.error,
      title: `⚠️ Ticket #${numero} sin cerrar (transcript incompleto)`,
      description: `Por ${cerradoPor} · ${motivo}. El canal quedó abierto.`,
    });
    return;
  }

  await canal.send({
    embeds: [
      brandEmbed({
        color: COLORS.error,
        title: `Ticket cerrado por ${nombreDe(cerradoPor)}`,
        description: `Se guardó un transcript con **${lineas.length}** mensajes. El canal se borra en **30 segundos**.`,
      }),
    ],
  }).catch(() => {});

  loguear(guild, {
    color: COLORS.warn,
    title: `Ticket #${numero} cerrado`,
    description: `Por ${cerradoPor} · transcript enviado a logs y al DM del usuario.`,
  });

  await new Promise((r) => {
    setTimeout(r, 30_000);
  });
  await canal.delete(`Ticket cerrado por ${nombreDe(cerradoPor)}`).catch(() => {});
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
        color: COLORS.info,
        title: 'Soporte',
        description:
          config.mensajes ||
          '¿Necesitás hablar con el staff? Abrí un ticket con el botón de abajo: se crea un canal privado solo para vos y el equipo.',
        footer: 'TriggerBOT • un ticket por persona',
      }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket:abrir').setLabel('Abrir ticket').setStyle(ButtonStyle.Primary)
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
        new TextInputBuilder().setCustomId('motivo').setLabel('Contanos brevemente qué pasa').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)
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
    await interaction.reply({ content: 'Cerrando el ticket…', flags: MessageFlags.Ephemeral });
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
  await interaction.editReply({ content: `Tu ticket quedó abierto en ${resultado.canal}.` });
}

module.exports = { abrirTicket, cerrarTicket, panel, configDe, esStaff, manejarBotonTicket, manejarModalTicket, dividirTranscript, LIMITE_ADJUNTO_BYTES };
