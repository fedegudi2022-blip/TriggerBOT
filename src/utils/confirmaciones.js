// Confirmación con botones (y deshacer opcional) para las acciones destructivas.
//
// Muchos comandos de moderación son irreversibles o de alto impacto (banear, softban,
// cerrar un canal): un typo en la opción `usuario` y la sanción ya se aplicó. Este
// módulo agrega un paso de confirmación reutilizable, con la misma UX en todos:
//
//   1. El comando valida TODO (jerarquía, permisos) y llama a pedir() con una función
//      `ejecutar` que aplica la acción. Nada se toca todavía.
//   2. El staff confirma con el botón. Recién ahí corre `ejecutar`.
//   3. Si el comando definió `deshacer`, el resultado ofrece un botón para revertir.
//
// Los tokens viven 60 s: una solicitud vieja no puede ejecutarse por accidente.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { brandEmbed, errorEmbed, COLORS } = require('./replies');

const VIDA_MS = 60_000;
const pendientes = new Map(); // token → { spec }
const deshacers = new Map(); // token → { fn }
let contador = 0;

function token() {
  contador += 1;
  return `${Date.now().toString(36)}${contador.toString(36)}`;
}

// Limpieza periódica de tokens vencidos (no se acumulan si nadie aprieta el botón).
setInterval(() => {
  const ahora = Date.now();
  for (const [t, entrada] of pendientes) if (entrada.expira < ahora) pendientes.delete(t);
  for (const [t, entrada] of deshacers) if (entrada.expira < ahora) deshacers.delete(t);
}, 30_000).unref();

// Muestra el panel de confirmación. Devuelve la respuesta de Discord.
// spec: { titulo, detalle, color?, pie?, silencioso?, deshacerLabel?, ejecutar, deshacer?, alEnviar? }
async function pedir(interaction, spec) {
  const t = token();
  pendientes.set(t, { spec, expira: Date.now() + VIDA_MS });

  const fila = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`conf:si:${t}`).setLabel('Confirmar').setEmoji('✅').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`conf:no:${t}`).setLabel('Cancelar').setEmoji('❌').setStyle(ButtonStyle.Secondary)
  );

  const embed = brandEmbed({
    color: spec.color ?? COLORS.warn,
    title: spec.titulo,
    description: `${spec.detalle}\n\n**¿Confirmás la acción?**`,
    footer: spec.pie ?? 'Tocá Confirmar solo si estás seguro · expira en 60 s',
  });

  // Si el comando ya difirió (p. ej. al resolver un miembro fuera de caché), se edita;
  // si no, se responde. La confirmación siempre es efímera: solo la ve quien la pide.
  if (interaction.deferred || interaction.replied) {
    // editReply no acepta `flags`: la defer original ya fijó la visibilidad.
    return interaction.editReply({ embeds: [embed], components: [fila] });
  }
  return interaction.reply({ embeds: [embed], components: [fila], flags: MessageFlags.Ephemeral });
}

// Maneja los clics de confirmar/cancelar/deshacer. Lo llama index.js.
async function manejarComponente(interaction) {
  const [, accion, t] = interaction.customId.split(':');

  if (accion === 'no') {
    pendientes.delete(t);
    return interaction.update({
      embeds: [brandEmbed({ color: COLORS.gris, title: '❌ Acción cancelada', description: `Cancelada por ${interaction.user}.` })],
      components: [],
    });
  }

  if (accion === 'deshacer') {
    const entrada = deshacers.get(t);
    if (!entrada || entrada.expira < Date.now()) {
      return interaction.update({ embeds: [errorEmbed('Ya no se puede deshacer esta acción.')], components: [] });
    }
    deshacers.delete(t);
    await interaction.deferUpdate();
    try {
      const salida = await entrada.fn(interaction);
      return interaction.editReply({ embeds: salida.embeds, components: [] });
    } catch (error) {
      return interaction.editReply({ embeds: [errorEmbed(`No se pudo deshacer.\n> ${error.message}`)], components: [] });
    }
  }

  // accion === 'si'
  const entrada = pendientes.get(t);
  if (!entrada || entrada.expira < Date.now()) {
    pendientes.delete(t);
    return interaction.update({ embeds: [errorEmbed('Esta confirmación expiró. Volvé a ejecutar el comando.')], components: [] });
  }
  pendientes.delete(t);
  const { spec } = entrada;
  await interaction.deferUpdate();

  let salida;
  try {
    salida = await spec.ejecutar(interaction);
  } catch (error) {
    return interaction.editReply({ embeds: [errorEmbed(`Falló la ejecución: ${error.message}`)], components: [] });
  }

  const embeds = salida.embeds ?? [];
  // Transparencia: si el staff no pidió modo silencioso, el resultado se anuncia en el
  // canal (misma política que el resto de la moderación). El panel efímero solo agrega
  // el botón de deshacer, que queda para quien confirmó.
  if (salida.ok && !spec.silencioso && interaction.channel?.send) {
    // `alEnviar` deja que el comando reaccione al mensaje público (p. ej. /clear lo
    // borra a los 5 s para no dejar la confirmación pegada en el canal).
    const enviado = await interaction.channel.send({ embeds }).catch(() => null);
    if (enviado && typeof spec.alEnviar === 'function') spec.alEnviar(enviado);
  }

  const componentes = [];
  if (salida.ok && typeof spec.deshacer === 'function') {
    const d = token();
    deshacers.set(d, { fn: spec.deshacer, expira: Date.now() + VIDA_MS });
    componentes.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`conf:deshacer:${d}`)
          .setLabel(spec.deshacerLabel ?? 'Deshacer')
          .setEmoji('↩️')
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

  return interaction.editReply({
    embeds: embeds.length ? embeds : [brandEmbed({ color: COLORS.success, title: '✅ Hecho' })],
    components: componentes,
  });
}

module.exports = { pedir, manejarComponente };
