// Tests de /top: cómo se presenta el ranking (un renglón por usuario, podio en negrita,
// tu puesto) y la paginación. Cada proceso de test usa su propio directorio de datos.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-top-'));

const top = require('../src/commands/top');
const niveles = require('../src/niveles');

const GUILD = 'guild-top';
const YO = 'yo';

// Interacción fake: junta lo que el comando responde (slash o botón de página).
function interaccionFake({ userId = YO, boton = null, pagina = null } = {}) {
  const capturado = { reply: null, update: null };
  return {
    capturado,
    isButton: () => boton !== null,
    customId: boton ?? '',
    guild: { id: GUILD, iconURL: () => null },
    user: { id: userId },
    options: { getInteger: () => pagina },
    reply: async (payload) => {
      capturado.reply = payload;
    },
    update: async (payload) => {
      capturado.update = payload;
    },
  };
}

// Carga el store con `cantidad` usuarios: u1 tiene la XP más alta y va bajando.
function sembrar(cantidad, { xpBase = 4000, paso = 100, yoXp = 760 } = {}) {
  const datos = {};
  for (let i = 1; i <= cantidad; i += 1) {
    const xp = xpBase - (i - 1) * paso;
    datos[`u${i}`] = { xp, nivel: niveles.nivelDe(xp), mensajes: 10 * i, findes: 0, racha: 0, logros: [] };
  }
  if (yoXp !== null) {
    datos[YO] = { xp: yoXp, nivel: niveles.nivelDe(yoXp), mensajes: 40, findes: 0, racha: 0, logros: [] };
  }
  niveles.escribir(GUILD, datos);
}

// Embed real → JSON, para leer lo que ve el usuario.
function embedDe(payload) {
  return payload.embeds[0].data;
}

function renglones(embed) {
  return embed.description.split('\n').filter((l) => l.startsWith('**#'));
}

describe('/top, presentación del ranking', () => {
  test('un renglón por usuario a todo el ancho, sin columnas', async () => {
    sembrar(5);
    const interaccion = interaccionFake();
    await top.execute(interaccion);

    const embed = embedDe(interaccion.capturado.reply);
    assert.equal(embed.fields, undefined, 'no se usan campos inline: ahí se cortaban los renglones');
    assert.equal(renglones(embed).length, 6, '5 usuarios + vos');
  });

  test('ordena por XP y el podio va entero en negrita', async () => {
    sembrar(5);
    const interaccion = interaccionFake();
    await top.execute(interaccion);

    const filas = renglones(embedDe(interaccion.capturado.reply));
    assert.ok(filas[0].startsWith('**#1 <@u1>'), filas[0]);
    assert.ok(filas[1].startsWith('**#2 <@u2>'), filas[1]);
    assert.ok(filas[0].endsWith('**'), 'el podio se destaca completo');
    assert.ok(filas[3].startsWith('**#4** <@u4>'), `del 4º para abajo solo se resalta el puesto: ${filas[3]}`);
    assert.ok(!filas[3].endsWith('**'), filas[3]);
  });

  test('cada renglón muestra rango, nivel, XP y mensajes con separador de miles', async () => {
    sembrar(1);
    const interaccion = interaccionFake();
    await top.execute(interaccion);

    const fila = renglones(embedDe(interaccion.capturado.reply))[0];
    assert.ok(fila.includes('— Activo · nivel 6 · 4.000 XP · 10 msj'), fila);
  });

  test('el renglón propio se marca y la última línea dice dónde estás y a quién alcanzar', async () => {
    sembrar(3); // u1 4.000 · u2 3.500 · u3 3.000 · vos 760
    const interaccion = interaccionFake();
    await top.execute(interaccion);

    const texto = embedDe(interaccion.capturado.reply).description;
    assert.ok(texto.includes(`<@${YO}> (vos)`), texto);
    assert.ok(texto.includes('Estás **#4** de 4'), texto);
    assert.ok(texto.includes('te faltan **3.040 XP** para pasar a <@u3> (#3) (~152 mensajes)'), texto);
  });

  test('quien va primero ve su ventaja y no un faltan 0 XP', async () => {
    sembrar(3, { yoXp: 5000 });
    const interaccion = interaccionFake();
    await top.execute(interaccion);

    const texto = embedDe(interaccion.capturado.reply).description;
    assert.ok(texto.includes('Vas **#1** de 4'), texto);
    assert.ok(texto.includes('1.000 XP de ventaja sobre <@u1> (#2)'), texto);
    assert.ok(!texto.includes('te faltan'), texto);
  });

  test('quien todavía no sumó XP recibe un aviso en vez de una línea vacía', async () => {
    sembrar(3, { yoXp: null });
    const interaccion = interaccionFake();
    await top.execute(interaccion);

    const texto = embedDe(interaccion.capturado.reply).description;
    assert.ok(texto.includes('No aparecés todavía en el ranking'), texto);
    assert.equal(renglones(embedDe(interaccion.capturado.reply)).length, 3);
  });

  test('la cabecera dice cuánta gente hay y el título en qué página estás', async () => {
    sembrar(12);
    const interaccion = interaccionFake({ pagina: 2 });
    await top.execute(interaccion);

    const embed = embedDe(interaccion.capturado.reply);
    assert.equal(embed.title, 'Ranking de actividad — página 2/2');
    assert.ok(embed.description.startsWith('13 jugadores con actividad'), embed.description);
    const filas = renglones(embed);
    assert.ok(filas[0].startsWith('**#11'), filas[0]);
    assert.equal(filas.length, 3, 'quedan los puestos 11, 12 y vos');
  });

  test('los botones de página se apagan en los extremos', async () => {
    sembrar(12);
    const primera = interaccionFake();
    await top.execute(primera);
    const [anterior, siguiente] = primera.capturado.reply.components[0].components.map((b) => b.data);
    assert.equal(anterior.disabled, true, 'en la página 1 no hay anterior');
    assert.equal(siguiente.disabled, false);
    assert.equal(siguiente.custom_id, 'top:page:2');

    // El botón vuelve a entrar por el mismo render, con la página en el customId.
    const segunda = interaccionFake({ boton: 'top:page:2' });
    await top.ejecutar(segunda, 2);
    const botones = segunda.capturado.update.components[0].components.map((b) => b.data);
    assert.equal(botones[0].disabled, false);
    assert.equal(botones[1].disabled, true, 'en la última no hay siguiente');
  });

  test('con una sola página no hay botones', async () => {
    sembrar(9); // 9 + vos = 10, justo una página
    const interaccion = interaccionFake();
    await top.execute(interaccion);
    assert.deepEqual(interaccion.capturado.reply.components, []);
  });

  test('si hay más de 100 jugadores lo dice en vez de cortar la lista en silencio', async () => {
    sembrar(101, { paso: 10 }); // 101 + vos, todos con XP positiva
    const interaccion = interaccionFake();
    await top.execute(interaccion);

    const embed = embedDe(interaccion.capturado.reply);
    assert.ok(embed.description.startsWith('102 jugadores con actividad · se listan los primeros 100'), embed.description);
    assert.equal(embed.title, 'Ranking de actividad — página 1/10');
  });

  test('sin actividad el mensaje explica cómo se entra al ranking', async () => {
    niveles.escribir(GUILD, {});
    const interaccion = interaccionFake();
    await top.execute(interaccion);

    assert.equal(interaccion.capturado.reply.embeds, undefined);
    assert.ok(interaccion.capturado.reply.content.includes('Todavía no hay actividad registrada'), interaccion.capturado.reply.content);
  });

  test('si un botón pide una página que ya no existe, se limpian los componentes', async () => {
    niveles.escribir(GUILD, {});
    const interaccion = interaccionFake({ boton: 'top:page:3' });
    await top.ejecutar(interaccion, 3);
    assert.deepEqual(interaccion.capturado.update, { components: [] });
  });
});
