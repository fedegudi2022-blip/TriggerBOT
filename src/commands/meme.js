const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { errorEmbed } = require('../utils/replies');

const SUBREDDITS = ['memes', 'memesesp', 'ArgentumOnline', 'ArgMemes', 'dankmemes'];
const cacheSubs = new Map(); // subreddit → { lista, cuando }

// Trae posts calientes de un subreddit vía la API JSON pública (sin clave).
async function traerMemes(subreddit) {
  const cacheado = cacheSubs.get(subreddit);
  if (cacheado && Date.now() - cacheado.cuando < 10 * 60 * 1000 && cacheado.lista.length) {
    return cacheado.lista;
  }

  const resp = await fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=50`, {
    headers: { 'User-Agent': 'TriggerBOT/1.0 (bot de Discord)' },
    signal: AbortSignal.timeout(6_000),
  });
  if (!resp.ok) throw new Error(`Reddit HTTP ${resp.status}`);

  const datos = await resp.json();
  const lista = (datos?.data?.children ?? [])
    .map((c) => c.data)
    .filter(
      (p) =>
        !p.stickied &&
        !p.over_18 &&
        (p.url_overridden_by_dest?.match(/\.(jpg|jpeg|png|gif)$/i) || p.is_gallery)
    )
    .map((p) => ({
      titulo: p.title,
      imagen: p.url_overridden_by_dest,
      autor: p.author,
      url: `https://reddit.com${p.permalink}`,
      votos: p.ups,
    }));

  if (lista.length) cacheSubs.set(subreddit, { lista, cuando: Date.now() });
  return lista;
}

// Elige un subreddit al azar y un post de su lista.
async function memeAleatorio() {
  const orden = [...SUBREDDITS].sort(() => Math.random() - 0.5);
  for (const sub of orden) {
    try {
      const lista = await traerMemes(sub);
      if (lista.length) return { sub, meme: lista[Math.floor(Math.random() * lista.length)] };
    } catch {
      continue; // subreddit caído o bloqueado: probamos el siguiente
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
      return interaction.editReply({ components: [] });
    }

    await interaction.editReply({
      embeds: [embedMeme(resultado.meme, resultado.sub)],
      components: [filaBoton()],
    });
  },
};
