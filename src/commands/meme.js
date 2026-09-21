const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { errorEmbed } = require('../utils/replies');

const SUBREDDITS = ['memes', 'memesesp', 'dankmemes', 'ArgMemes', 'me_irl'];
const cacheSubs = new Map(); // subreddit → { lista, cuando }

// Corta-corriente: si Reddit rechaza (403/429 típico contra hosts de nube), se lo
// evita 30 min y se va directo al espejo. Hace /meme instantáneo en vez de
// acumular fallos lentos por cada subreddit.
let redditBloqueadoHasta = 0;

// User-Agent descriptivo (Reddit exige identificarse; los UAs genéricos reciben 403).
const UA = 'TriggerBOT/1.0 (bot de Discord para comunidad gaming; contacto: servidor Trigger)';

// ---------- Fuente 1: API JSON de Reddit ----------
async function traerDesdeReddit(subreddit) {
  const resp = await fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=50`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(6_000),
  });
  if (!resp.ok) throw new Error(`Reddit HTTP ${resp.status}`);

  const datos = await resp.json();
  return (datos?.data?.children ?? [])
    .map((c) => c.data)
    .filter((p) => !p.stickied && !p.over_18 && (p.url_overridden_by_dest?.match(/\.(jpg|jpeg|png|gif)$/i) || p.is_gallery))
    .map((p) => ({
      titulo: p.title,
      imagen: p.url_overridden_by_dest,
      autor: p.author,
      url: `https://reddit.com${p.permalink}`,
      votos: p.ups,
    }));
}

// ---------- Fuente 2: espejo público meme-api.com (proxy de Reddit, sin clave) ----------
async function traerDesdeEspejo(subreddit) {
  const resp = await fetch(`https://meme-api.com/gimme/${subreddit}/50`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(6_000),
  });
  if (!resp.ok) throw new Error(`Espejo HTTP ${resp.status}`);

  const datos = await resp.json();
  const crudos = Array.isArray(datos?.memes) ? datos.memes : datos?.url ? [datos] : [];
  return crudos
    .filter((m) => !m.nsfw && !m.spoiler && m.url?.match(/\.(jpg|jpeg|png|gif)$/i))
    .map((m) => ({
      titulo: m.title ?? 'Meme',
      imagen: m.url,
      autor: m.author ?? 'reddit',
      url: m.postLink ?? `https://reddit.com/r/${subreddit}`,
      votos: m.ups ?? 0,
    }));
}

// Trae memes de un subreddit probando fuente por fuente, con caché de 10 min.
async function traerMemes(subreddit) {
  const cacheado = cacheSubs.get(subreddit);
  if (cacheado && Date.now() - cacheado.cuando < 10 * 60 * 1000 && cacheado.lista.length) {
    return cacheado.lista;
  }

  const fuentes = Date.now() < redditBloqueadoHasta ? [traerDesdeEspejo] : [traerDesdeReddit, traerDesdeEspejo];
  let lista = [];
  for (const fuente of fuentes) {
    try {
      lista = await fuente(subreddit);
      if (lista.length) break;
    } catch (error) {
      // Reddit rechazando: se lo salta por 30 min y siguen con el espejo.
      if (fuente === traerDesdeReddit && /HTTP (403|429)/.test(error.message)) {
        redditBloqueadoHasta = Date.now() + 30 * 60 * 1000;
      }
      continue;
    }
  }

  if (lista.length) cacheSubs.set(subreddit, { lista, cuando: Date.now() });
  return lista;
}

// Elige subreddits al azar y devuelve el primero con memes disponibles.
async function memeAleatorio() {
  const orden = [...SUBREDDITS].sort(() => Math.random() - 0.5);
  for (const sub of orden) {
    try {
      const lista = await traerMemes(sub);
      if (lista.length) return { sub, meme: lista[Math.floor(Math.random() * lista.length)] };
    } catch {
      continue;
    }
  }
  return null;
}

function embedMeme(meme, sub) {
  return new EmbedBuilder()
    .setColor(0xff4500)
    .setTitle(meme.titulo.slice(0, 256))
    .setImage(meme.imagen)
    .setURL(meme.url)
    .setFooter({ text: `r/${sub} • u/${meme.autor} • 👍 ${meme.votos.toLocaleString('es-AR')}` });
}

const filaBoton = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('meme:otro').setLabel('Otro').setStyle(ButtonStyle.Primary).setEmoji('🎲')
  );

module.exports = {
  data: new SlashCommandBuilder()
    .setName('meme')
    .setDescription('Meme al azar de Reddit (con botón para pedir otro)'),

  async execute(interaction) {
    await interaction.deferReply();
    const resultado = await memeAleatorio();

    if (!resultado) {
      return interaction.editReply({ embeds: [errorEmbed('Reddit no está respondiendo ahora mismo. Probá en un rato.')] });
    }

    await interaction.editReply({ embeds: [embedMeme(resultado.meme, resultado.sub)], components: [filaBoton()] });
  },

  // Botón "Otro": edita el mismo mensaje con un meme nuevo (sin gastar otro /meme).
  async boton(interaction) {
    await interaction.deferUpdate();
    const resultado = await memeAleatorio();

    if (!resultado) {
      // Se mantiene el meme actual; solo se avisa y se saca el botón para no crear bucles de reintento.
      return interaction.editReply({
        embeds: [errorEmbed('Reddit no responde para traer otro. Este se queda; probá de nuevo en un rato.')],
        components: [],
      });
    }

    await interaction.editReply({
      embeds: [embedMeme(resultado.meme, resultado.sub)],
      components: [filaBoton()],
    });
  },
};
