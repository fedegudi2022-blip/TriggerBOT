// Sistema de tickets de soporte: un panel con selector de tipo en un canal; al elegir
// uno se abre el formulario del tipo y se crea un canal privado visible solo por el
// usuario y el staff. El staff puede reclamarlo (queda a su nombre), sumar gente y
// cerrarlo. Al cerrar se genera un transcript .txt, se manda a los logs, se borra el
// canal y el usuario recibe una encuesta 1-5 para calificar la atención.
// Tipos: soporte, apelación y reporte de cheater (ver TIPOS). /reportar abre un
// reporte sin pasar por el panel.
//
// Config (config.tickets en store.js): { categoriaId, canalLogs, mensajes, contador,
//   activos, encuestas, calificaciones }
// Estado de cada ticket (en el topic del canal): guildId:userId:numero:tipo
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { nombreDe, brandEmbed, COLORS, textoDuracion } = require('./replies');
const { getGuildConfig, setGuildConfig } = require('../store');
const { autorizadoDe } = require('./permisos');
const crearLogger = require('../logger');

const log = crearLogger('tickets');

function configDe(guildId) {
  return getGuildConfig(guildId).tickets ?? {};
}

// ---------- Tipos de ticket ----------
// Cada tipo define su etiqueta, el prefijo del canal y las preguntas de su modal.
// Es la única fuente: el panel, los formularios, el embed del ticket y el resumen
// del cierre salen de acá, así agregar un tipo es agregar una entrada.
const TIPOS = {
  soporte: {
    etiqueta: 'Soporte',
    descripcion: 'Dudas, problemas técnicos o con tu cuenta',
    prefijo: 'soporte',
    campos: [{ id: 'motivo', etiqueta: 'Contanos qué necesitás', max: 500, parrafo: true }],
  },
  apelacion: {
    etiqueta: 'Apelación',
    descripcion: 'Pedí que revisen una sanción (ban, mute, warn)',
    prefijo: 'apelacion',
    campos: [
      { id: 'sancion', etiqueta: 'Qué sanción apelás (y cuándo)', max: 200 },
      { id: 'motivo', etiqueta: 'Por qué deberíamos levantarla', max: 500, parrafo: true },
    ],
  },
  reporte: {
    etiqueta: 'Reporte de cheater',
    descripcion: 'Reportá a alguien con pruebas (captura, video, demo)',
    prefijo: 'reporte',
    campos: [
      { id: 'reportado', etiqueta: 'Usuario o ID del reportado', max: 100 },
      { id: 'pruebas', etiqueta: 'Qué hizo y qué pruebas tenés', max: 500, parrafo: true },
      { id: 'adjunto', etiqueta: 'Link a las pruebas (opcional)', max: 200, requerido: false },
    ],
  },
};
const TIPO_POR_DEFECTO = 'soporte';
const MAX_CALIFICACIONES = 100; // se guardan las últimas: es un termómetro, no un archivo

// Tipo con su id incluido (así el resto del código usa tipo.id / tipo.prefijo).
function tipoDe(id) {
  return TIPOS[id] ? { id, ...TIPOS[id] } : null;
}

// ---------- Estado de los tickets abiertos ----------
// config.tickets.activos[canalId] = { numero, userId, tipo, ts, reclamadoPor, reclamadoEn }
// Vive en la config para que un reinicio del bot no le borre el tipo, el número ni
// quién lo estaba atendiendo.
function activoDe(guildId, canalId) {
  return configDe(guildId).activos?.[canalId] ?? null;
}

function marcarActivo(guildId, canalId, datos) {
  setGuildConfig(guildId, (c) => {
    c.tickets = c.tickets || {};
    c.tickets.activos = c.tickets.activos || {};
    c.tickets.activos[canalId] = { ...(c.tickets.activos[canalId] ?? {}), ...datos };
  });
  return activoDe(guildId, canalId);
}

function borrarActivo(guildId, canalId) {
  setGuildConfig(guildId, (c) => {
    if (!c.tickets?.activos?.[canalId]) return;
    delete c.tickets.activos[canalId];
    if (!Object.keys(c.tickets.activos).length) delete c.tickets.activos;
  });
}

// Datos del ticket leídos del topic (fuente original) cruzados con lo guardado.
// Sirve para tickets abiertos antes de este cambio: sin entrada en `activos`
// igual se sabe quién lo abrió, el número y el tipo.
function datosDeCanal(canal) {
  const [guildId, userId, numero, tipo] = String(canal.topic ?? '').split(':');
  return { guildId: guildId ?? canal.guild.id, userId: userId ?? null, numero: numero ?? null, tipo: tipoDe(tipo) ?? tipoDe(TIPO_POR_DEFECTO) };
}

// Límite de adjunto de Discord (8 MiB sin boosts). Dejamos margen: si el transcript
// lo supera, se parte en varios archivos en vez de que el envío falle en silencio.
const LIMITE_ADJUNTO_BYTES = 7_800_000;
// Gracia antes de borrar el canal ya cerrado (los tests la bajan a 0).
const GRACIA_MS = 30_000;

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
    new ButtonBuilder().setCustomId('ticket:reclamar').setLabel('Reclamar').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:agregar').setLabel('Agregar usuario').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:cerrar').setLabel('Cerrar ticket').setStyle(ButtonStyle.Danger)
  );
}

// Bloqueo anti-carrera: dos clics casi simultáneos pueden pasar ambos el chequeo de
// "ya tenés un ticket" antes de que ninguno creara el canal → dos tickets por persona.
// Mientras se crea el canal, el userId queda en este Set y el segundo intento sale.
const abriendoAhora = new Set();

// Abre un ticket para el usuario. Devuelve el canal creado o { error }.
async function abrirTicket(interaction, { tipo: tipoId = TIPO_POR_DEFECTO, campos = {} } = {}) {
  const guild = interaction.guild;
  const user = interaction.user;
  const config = configDe(guild.id);
  const raiz = getGuildConfig(guild.id);
  const tipo = tipoDe(tipoId) ?? tipoDe(TIPO_POR_DEFECTO);

  const claveAbriendo = `${guild.id}:${user.id}`;
  if (abriendoAhora.has(claveAbriendo)) {
    return { error: 'Ya estoy abriendo tu ticket, esperá unos segundos...' };
  }
  abriendoAhora.add(claveAbriendo);
  try {
    return await abrirTicketInterno(interaction, { tipo, campos }, { config, raiz });
  } finally {
    abriendoAhora.delete(claveAbriendo);
  }
}

async function abrirTicketInterno(interaction, { tipo, campos }, { config, raiz }) {
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
    name: `${tipo.prefijo}-${numeroTxt}`,
    type: ChannelType.GuildText,
    parent: config.categoriaId && guild.channels.cache.has(config.categoriaId) ? config.categoriaId : null,
    permissionOverwrites: overrides,
    topic: `${guild.id}:${user.id}:${numeroTxt}:${tipo.id}`,
    reason: `Ticket de ${nombreDe(user)} (${tipo.etiqueta})`,
  });

  // Lo que el usuario escribió en el formulario, con la etiqueta de cada pregunta.
  const detalle = tipo.campos
    .map((campo) => (campos?.[campo.id] ? `**${campo.etiqueta}:** ${campos[campo.id]}` : null))
    .filter(Boolean)
    .join('\n');

  await canal.send({
    content: `${user}, acá está tu ticket. El staff te va a responder a la brevedad.`,
    embeds: [
      brandEmbed({
        color: COLORS.info,
        title: `Ticket #${numeroTxt} — ${tipo.etiqueta}`,
        description: `**Usuario:** ${user} (\`${nombreDe(user)}\`)\n\n${detalle || '*sin detalle*'}`,
        footer: 'TriggerBOT • el staff puede reclamarlo, sumar gente o cerrarlo',
      }),
    ],
    components: [botonesTicket()],
  });

  // Queda anotado para el cierre: tipo, número, apertura y quién lo atiende.
  marcarActivo(guild.id, canal.id, { numero: numeroTxt, userId: user.id, tipo: tipo.id, ts: Date.now() });

  loguear(guild, {
    color: COLORS.success,
    title: 'Ticket abierto',
    description: `${user} abrió el ticket **#${numeroTxt}** (${tipo.etiqueta}) → <#${canal.id}>`,
  });

  return { canal, numero };
}

// Cierra el ticket del canal actual: transcript, DM, encuesta de calificación, log y
// borra el canal (30 s de gracia, configurable para los tests).
async function cerrarTicket(interaction, cerradoPor, { graciaMs = GRACIA_MS } = {}) {
  const canal = interaction.channel;
  const [, userId, numero] = canal.topic?.split(':') ?? [];
  const guild = canal.guild;
  const activo = activoDe(guild.id, canal.id);
  const tipo = tipoDe(activo?.tipo) ?? tipoDe(canal.topic?.split(':')[3]) ?? tipoDe(TIPO_POR_DEFECTO);
  const atendidoPor = activo?.reclamadoPor ?? null;
  const duracionTxt = activo?.ts ? textoDuracion(Date.now() - activo.ts) : null;

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
                      `**Tipo:** ${tipo.etiqueta}\n**Abierto por:** <@${userId}>\n**Atendido por:** ${atendidoPor ? `<@${atendidoPor}>` : '*nadie lo reclamó*'}\n` +
                      `**Cerrado por:** ${cerradoPor}${duracionTxt ? `\n**Duración:** ${duracionTxt}` : ''}\n**Mensajes:** ${lineas.length}` +
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

  // Resumen del staff con lo que importa para saber qué pasó con el ticket.
  const resumen = [
    `**Tipo:** ${tipo.etiqueta}`,
    `**Abierto por:** <@${userId}>`,
    `**Atendido por:** ${atendidoPor ? `<@${atendidoPor}>` : '*nadie lo reclamó*'}`,
    `**Cerrado por:** ${nombreDe(cerradoPor)}`,
    ...(duracionTxt ? [`**Duración:** ${duracionTxt}`] : []),
    `**Mensajes:** ${lineas.length}`,
  ].join('\n');

  await canal.send({
    embeds: [
      brandEmbed({
        color: COLORS.error,
        title: `Ticket cerrado por ${nombreDe(cerradoPor)}`,
        description: `${resumen}\n\nSe guardó un transcript con **${lineas.length}** mensajes. El canal se borra en **30 segundos**.`,
      }),
    ],
  }).catch(() => {});

  // Encuesta 1-5 al dueño del ticket (le dice al staff cómo estuvo la atención).
  const encuestaEnviada = await pedirCalificacion(guild, { userId, numero, atendidoPor, cerradoPor });

  loguear(guild, {
    color: COLORS.warn,
    title: `Ticket #${numero} cerrado`,
    description:
      `Por ${cerradoPor} · transcript enviado a logs y al DM del usuario.` +
      (encuestaEnviada ? ' Se le pidió una calificación de 1 a 5.' : ' No pude mandarle la encuesta por DM.'),
  });

  // El ticket ya no está activo: se limpia el estado (reclamo incluido).
  borrarActivo(guild.id, canal.id);

  await new Promise((r) => {
    setTimeout(r, graciaMs);
  });
  await canal.delete(`Ticket cerrado por ${nombreDe(cerradoPor)}`).catch(() => {});
}

// ---------- Calificación del cierre ----------
// Se pide una vez por cierre: el pendiente queda en la config (`tickets.encuestas`),
// así el usuario puede apretar el botón más tarde (incluso si el canal ya no existe).
function encuestaPendienteDe(guildId, userId) {
  return configDe(guildId).encuestas?.[userId] ?? null;
}

async function pedirCalificacion(guild, { userId, numero, atendidoPor, cerradoPor }) {
  if (!userId) return false;
  const duenio = await guild.client.users.fetch(userId).catch(() => null);
  if (!duenio) return false;

  const botones = new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map((n) =>
      new ButtonBuilder()
        .setCustomId(`ticket:calificar:${guild.id}:${n}`)
        .setLabel(`${n}/5`)
        .setStyle(n <= 2 ? ButtonStyle.Danger : n === 3 ? ButtonStyle.Secondary : ButtonStyle.Success)
    )
  );

  const enviado = await duenio
    .send({
      embeds: [
        brandEmbed({
          color: COLORS.info,
          title: `¿Cómo estuvo la atención del ticket #${numero}?`,
          description: `Te atendió ${atendidoPor ? `<@${atendidoPor}>` : `**${nombreDe(cerradoPor)}**`}. Tocá un número del 1 al 5: lo ve solo el staff.`,
        }),
      ],
      components: [botones],
    })
    .then(() => true)
    .catch(() => false);

  if (enviado) {
    setGuildConfig(guild.id, (c) => {
      c.tickets = c.tickets || {};
      c.tickets.encuestas = c.tickets.encuestas || {};
      c.tickets.encuestas[userId] = { numero, staffId: atendidoPor ?? null, ts: Date.now() };
    });
  }
  return enviado;
}

// Guarda la calificación y limpia el pendiente. Devuelve el registro guardado.
function guardarCalificacion(guildId, userId, { numero, staffId, valor }) {
  const registro = { numero, userId, staffId: staffId ?? null, valor, ts: Date.now() };
  setGuildConfig(guildId, (c) => {
    c.tickets = c.tickets || {};
    c.tickets.calificaciones = [...(c.tickets.calificaciones ?? []), registro].slice(-MAX_CALIFICACIONES);
    if (c.tickets.encuestas?.[userId]) {
      delete c.tickets.encuestas[userId];
      if (!Object.keys(c.tickets.encuestas).length) delete c.tickets.encuestas;
    }
  });
  return registro;
}

// Promedio de las últimas calificaciones (lo usa el aviso al staff).
function promedioCalificaciones(guildId) {
  const valores = (configDe(guildId).calificaciones ?? []).map((c) => c.valor).filter((v) => Number.isFinite(v));
  if (!valores.length) return null;
  return valores.reduce((a, b) => a + b, 0) / valores.length;
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
        new StringSelectMenuBuilder()
          .setCustomId('ticket:sel:tipo')
          .setPlaceholder('Elegí el tipo de ticket')
          .addOptions(Object.entries(TIPOS).map(([id, t]) => ({ label: t.etiqueta, value: id, description: t.descripcion })))
      ),
    ],
  };
}

// Modal con las preguntas del tipo elegido. Cada campo es una fila del modal.
function modalDeTipo(tipo) {
  const modal = new ModalBuilder().setCustomId(`ticket:modal:${tipo.id}`).setTitle(`Ticket — ${tipo.etiqueta}`);
  for (const campo of tipo.campos) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(campo.id)
          .setLabel(campo.etiqueta)
          .setStyle(campo.parrafo ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setMaxLength(campo.max)
          .setRequired(campo.requerido !== false)
      )
    );
  }
  return modal;
}

// ---------- Handlers de botones (conectados desde index.js) ----------

async function manejarBotonTicket(interaction) {
  const accion = interaction.customId.split(':')[1];

  // Panel viejo (publicado antes de los tipos): se asume soporte.
  if (accion === 'abrir') {
    return interaction.showModal(modalDeTipo(tipoDe(TIPO_POR_DEFECTO)));
  }

  // Reclamar: el ticket queda a nombre del staff que lo atiende.
  if (accion === 'reclamar') {
    if (!esStaff(interaction.member)) {
      return interaction.reply({ content: 'Solo el staff puede reclamar el ticket.', flags: MessageFlags.Ephemeral });
    }
    const guildId = interaction.guild.id;
    const canal = interaction.channel;
    const activo = activoDe(guildId, canal.id);
    if (activo?.reclamadoPor && activo.reclamadoPor !== interaction.user.id) {
      return interaction.reply({ content: `Este ticket ya lo está atendiendo <@${activo.reclamadoPor}>.`, flags: MessageFlags.Ephemeral });
    }
    const datos = datosDeCanal(canal);
    marcarActivo(guildId, canal.id, { reclamadoPor: interaction.user.id, reclamadoEn: Date.now(), numero: activo?.numero ?? datos.numero, tipo: activo?.tipo ?? datos.tipo.id, userId: activo?.userId ?? datos.userId });
    await canal
      .send({
        embeds: [
          brandEmbed({
            color: COLORS.success,
            title: 'Ticket reclamado',
            description: `${interaction.user} se está haciendo cargo del ticket. Ya no hace falta que otro del staff lo revise.`,
          }),
        ],
      })
      .catch(() => {});
    return interaction.reply({ content: 'Listo, el ticket quedó a tu nombre.', flags: MessageFlags.Ephemeral });
  }

  // Agregar gente al ticket (por ID o mención).
  if (accion === 'agregar') {
    if (!esStaff(interaction.member)) {
      return interaction.reply({ content: 'Solo el staff puede sumar gente al ticket.', flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder().setCustomId('ticket:modal:agregar').setTitle('Agregar usuario al ticket');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('usuario')
          .setLabel('ID o mención del usuario')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
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
    return;
  }

  // Calificación 1-5 desde el DM (el customId lleva el server porque en DM no hay guild).
  if (accion === 'calificar') {
    const [, , guildId, valorTxt] = interaction.customId.split(':');
    const valor = Math.min(Math.max(Math.round(Number(valorTxt)) || 0, 1), 5);
    const pendiente = encuestaPendienteDe(guildId, interaction.user.id);
    if (!pendiente) {
      return interaction.reply({ content: 'Esa encuesta ya está respondida (o venció).', flags: MessageFlags.Ephemeral });
    }
    const registro = guardarCalificacion(guildId, interaction.user.id, { ...pendiente, valor });

    // El aviso va al canal de logs del server: es información para el staff.
    const guild = interaction.client.guilds?.cache?.get(guildId) ?? null;
    if (guild) {
      const raiz = getGuildConfig(guildId);
      const canalLogs = guild.channels.cache.get(configDe(guildId).canalLogs || raiz.logs || raiz.avisosChannel);
      const promedio = promedioCalificaciones(guildId);
      canalLogs
        ?.send({
          embeds: [
            brandEmbed({
              color: valor >= 4 ? COLORS.success : valor === 3 ? COLORS.info : COLORS.warn,
              title: `Ticket #${registro.numero} calificado con ${valor}/5`,
              description:
                `**Calificó:** <@${interaction.user.id}> (dueño del ticket)\n` +
                `**Atendido por:** ${registro.staffId ? `<@${registro.staffId}>` : '*nadie lo reclamó*'}` +
                (promedio === null ? '' : `\n**Promedio:** ${promedio.toFixed(1)}/5`),
            }),
          ],
        })
        .catch(() => {});
    }

    return interaction.update({ content: `¡Gracias! Quedó registrado con **${valor}/5**.`, embeds: [], components: [] });
  }
}

// Selector del panel: el tipo elegido abre su formulario.
async function manejarSelectTicket(interaction) {
  const tipo = tipoDe(interaction.values?.[0]);
  if (!tipo) {
    return interaction.reply({ content: 'No reconocí ese tipo de ticket.', flags: MessageFlags.Ephemeral });
  }
  return interaction.showModal(modalDeTipo(tipo));
}

async function manejarModalTicket(interaction) {
  const partes = interaction.customId.split(':'); // ticket:modal[:<tipo>]

  // Modal de "agregar usuario": no abre ticket, le da acceso al canal.
  if (partes[2] === 'agregar') {
    const id = String(interaction.fields.getTextInputValue('usuario')).match(/\d{17,20}/)?.[0];
    if (!id) {
      return interaction.reply({ content: '⚠️ No encontré una ID válida ahí. Copiala con clic derecho → **Copiar ID de usuario**.', flags: MessageFlags.Ephemeral });
    }
    const miembro = await interaction.guild.members.fetch(id).catch(() => null);
    if (!miembro) {
      return interaction.reply({ content: '⚠️ No pude encontrar a ese usuario en el servidor.', flags: MessageFlags.Ephemeral });
    }
    const resultado = await interaction.channel.permissionOverwrites
      .edit(id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
      })
      .then(() => null)
      .catch((error) => error);
    if (resultado) {
      return interaction.reply({ content: `⚠️ No pude darle acceso: ${resultado.message}`, flags: MessageFlags.Ephemeral });
    }
    await interaction.channel
      .send({
        embeds: [
          brandEmbed({
            color: COLORS.info,
            title: 'Usuario agregado',
            description: `${miembro} se sumó al ticket, invitado por ${interaction.user}.`,
          }),
        ],
      })
      .catch(() => {});
    return interaction.reply({ content: `Listo, ${nombreDe(miembro.user, miembro)} ya ve el ticket.`, flags: MessageFlags.Ephemeral });
  }

  const tipo = tipoDe(partes[2]) ?? tipoDe(TIPO_POR_DEFECTO);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Se guarda lo que el usuario escribió, campo por campo, con los topes del tipo.
  const campos = {};
  for (const campo of tipo.campos) {
    const valor = String(interaction.fields.getTextInputValue(campo.id) ?? '').trim();
    if (valor) campos[campo.id] = valor.slice(0, campo.max);
  }

  const resultado = await abrirTicket(interaction, { tipo: tipo.id, campos });
  if (resultado.error) {
    return interaction.editReply({ content: `⚠️ ${resultado.error}` });
  }
  await interaction.editReply({ content: `Tu ticket de **${tipo.etiqueta}** quedó abierto en ${resultado.canal}.` });
}

module.exports = {
  abrirTicket,
  cerrarTicket,
  panel,
  configDe,
  esStaff,
  TIPOS,
  tipoDe,
  activoDe,
  marcarActivo,
  borrarActivo,
  encuestaPendienteDe,
  guardarCalificacion,
  promedioCalificaciones,
  manejarBotonTicket,
  manejarSelectTicket,
  manejarModalTicket,
  dividirTranscript,
  LIMITE_ADJUNTO_BYTES,
  GRACIA_MS,
};
