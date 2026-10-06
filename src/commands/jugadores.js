// /jugadores — quién está conectado ahora en los servers CS 1.6.
//
// El protocolo A2S ya traía la lista de jugadores (nombre, puntaje y segundos
// conectado) y el bot la descartaba: el monitoreo solo usaba el conteo. Este comando la
// muestra, que es la pregunta que más se repite en el canal ("¿hay gente?").
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { brandEmbed, warnEmbed, miles, COLORS } = require('../utils/replies');
const monitoreo = require('../utils/monitoreo');
const { getGuildConfig } = require('../store');

const MAX_SERVIDORES = 20; // un embed aguanta 25 campos
const MAX_JUGADORES = 20; // por server: más renglones no se leen
const MAX_CARACTERES = 1000; // el límite real de un campo de embed es 1024

// Segundos conectado → "12 min" o "2 h 5 min".
function tiempoConectado(segundos) {
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `${Math.max(minutos, 1)} min`;
  return `${Math.floor(minutos / 60)} h ${minutos % 60} min`;
}

// Un renglón por jugador. Solo lo que se mira: quién es, cuánto lleva y cómo va.
function lineaDe(jugador) {
  const partes = [`${miles(jugador.puntaje ?? 0)} pts`];
  if (jugador.duracion > 0) partes.push(tiempoConectado(jugador.duracion));
  return `**${jugador.nombre}** — ${partes.join(' · ')}`;
}

// Lo que va en el campo de un server. Un server lleno (32 jugadores) no puede romper el
// embed, así que se corta por cantidad y por caracteres, y se dice cuántos quedaron afuera.
function roster(resultado) {
  if (!resultado.ok) return '*No responde ahora.*';

  const datos = resultado.datos;
  const jugadores = [...(datos.lista ?? [])].sort((a, b) => (b.puntaje ?? 0) - (a.puntaje ?? 0));
  if (!jugadores.length) {
    // "Está vacío" y "no me quiso dar la lista" son problemas distintos: se dicen distinto.
    return datos.jugadores > 0 ? '*El server no informa su lista de jugadores.*' : '*Sin jugadores conectados.*';
  }

  const lineas = [];
  for (const jugador of jugadores.slice(0, MAX_JUGADORES)) {
    const texto = lineaDe(jugador);
    if (lineas.length && [...lineas, texto].join('\n').length > MAX_CARACTERES) break;
    lineas.push(texto);
  }
  const resto = jugadores.length - lineas.length;
  return lineas.join('\n') + (resto > 0 ? `\n*…y ${resto} más.*` : '');
}

module.exports = {
  // Consulta todos los servers por UDP (A2S) en cada uso: 5 s por usuario.
  cooldown: 5,

  data: new SlashCommandBuilder()
    .setName('jugadores')
    .setDescription('Quién está conectado ahora en los servidores CS 1.6, con puntaje y tiempo')
    .addStringOption((o) => o.setName('servidor').setDescription('Filtrá por nombre (ej: publico, kz, automix)')),

  async execute(interaction) {
    const servers = getGuildConfig(interaction.guild.id).servidores?.lista ?? [];

    // Sin configurar no se consulta nada: el error de configuración se dice antes de
    // gastar el UDP de nadie.
    if (!servers.length) {
      return interaction.reply({
        embeds: [warnEmbed('El staff todavía no los cargó en `/config → Servidores CS 1.6`.', 'Sin servidores configurados')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const filtro = (interaction.options.getString('servidor') ?? '').trim();
    const elegidos = monitoreo.filtrarServidores(servers, filtro);

    if (!elegidos.length) {
      return interaction.reply({
        embeds: [warnEmbed(`Probá con: ${servers.map((s) => `\`${s.nombre}\``).join(' · ')}`, 'No encontré ese servidor')],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Diferido antes de consultar: cada server puede tardar hasta su timeout de A2S y
    // sin esto Discord cierra la interacción antes de que lleguen los datos.
    await interaction.deferReply();

    const mostrados = elegidos.slice(0, MAX_SERVIDORES);
    const resultados = await Promise.all(
      mostrados.map(async (server) => {
        const [host, puerto] = monitoreo.parsearDestino(server);
        return { server, resultado: await monitoreo.consultar(host, puerto) };
      })
    );

    const conectados = resultados.reduce((total, { resultado }) => total + (resultado.ok ? resultado.datos.jugadores : 0), 0);
    const sobrantes = elegidos.length - mostrados.length;

    const embed = brandEmbed({
      color: COLORS.info,
      title: 'Jugadores conectados',
      description:
        `**${miles(conectados)}** jugador(es) en **${mostrados.length}** server(s).` +
        (sobrantes ? ` Se muestran los primeros ${MAX_SERVIDORES}.` : ''),
      fields: resultados.map(({ server, resultado }) => ({
        name: resultado.ok
          ? `${server.nombre} — ${resultado.datos.jugadores}/${resultado.datos.maximo} · \`${resultado.datos.mapa}\``
          : `${server.nombre} — sin respuesta`,
        value: roster(resultado),
      })),
      footer: 'TriggerBOT • /ip para conectarte',
    });

    return interaction.editReply({ embeds: [embed] });
  },
};
