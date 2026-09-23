// Tests de la búsqueda web (utils/web.js) con el fetch inyectado: cero red.
//
// Cubren las tres cosas que pueden romper la promesa de "el bot busca y responde":
// cuándo corresponde buscar (charla social no, comunidad no, cultura general sí),
// que el parseo de cada fuente aguante el formato real, y que los costos estén
// acotados (caché, cooldown por usuario y tope por minuto).

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const web = require('../src/utils/web');

function json(cuerpo, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => cuerpo, text: async () => JSON.stringify(cuerpo) };
}

function html(cuerpo, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => cuerpo };
}

const PAGINA_WIKI = {
  query: {
    pages: {
      1: {
        index: 1,
        title: 'Lionel Messi',
        extract: 'Lionel Andrés Messi Cuccittini (Rosario, 24 de junio de 1987) es un futbolista argentino. Juega como delantero y es capitán de la selección.',
        fullurl: 'https://es.wikipedia.org/wiki/Lionel_Messi',
      },
    },
  },
};

// Fake de fetch que distingue fuente por URL. `pedidas` permite contar llamadas
// (para verificar la caché) sin salir a internet.
function fetchFalso({ wiki, wikiEn, ddg, lite, dolar, geo, meteo } = {}) {
  const pedidas = [];
  const impl = async (url) => {
    const u = String(url);
    pedidas.push(u);
    if (u.includes('es.wikipedia.org')) return wiki ? json(wiki) : json({}, 500);
    if (u.includes('en.wikipedia.org')) return wikiEn ? json(wikiEn) : json({}, 500);
    if (u.includes('api.duckduckgo.com')) return ddg ? json(ddg) : json({}, 500);
    if (u.includes('lite.duckduckgo.com')) return lite ? html(lite) : html('', 500);
    if (u.includes('bluelytics')) return dolar ? json(dolar) : json({}, 500);
    if (u.includes('geocoding-api.open-meteo.com')) return geo ? json(geo) : json({}, 500);
    if (u.includes('api.open-meteo.com')) return meteo ? json(meteo) : json({}, 500);
    return json({}, 404);
  };
  return { impl, pedidas };
}

const COTIZACION = {
  oficial: { value_avg: 1509.5, value_sell: 1537, value_buy: 1482 },
  blue: { value_avg: 1541, value_sell: 1558, value_buy: 1524 },
  last_update: '2026-09-23T12:45:51-03:00',
};

const GEO_ROSARIO = {
  results: [
    {
      name: 'Rosario',
      admin1: 'Provincia de Santa Fe',
      country: 'Argentina',
      latitude: -32.94,
      longitude: -60.63,
      timezone: 'America/Argentina/Cordoba',
    },
  ],
};

const PRONOSTICO = {
  current: { temperature_2m: 17, apparent_temperature: 15.5 },
  daily: { temperature_2m_max: [18.9, 23.1], temperature_2m_min: [7.9, 11.9], precipitation_probability_max: [0, 40] },
};

// Consulta de búsqueda de Wikipedia (desenvuelta, para poder afirmar con qué texto se
// salió a internet en cada ronda).
const consultaWiki = (url) => {
  const m = /gsrsearch=([^&]*)/.exec(String(url));
  return m ? decodeURIComponent(m[1]) : '';
};

beforeEach(() => {
  web.reiniciar();
  web.usarFetch(async () => json({}, 503)); // por defecto: sin red
});

describe('decidirBusqueda — cuándo sale a buscar', () => {
  test('una pregunta de cultura general busca, pero no antes de responder', () => {
    assert.deepEqual(web.decidirBusqueda('messi cuantos anios tiene', { perfil: 'consulta' }), {
      buscar: true,
      forzar: false,
    });
    assert.deepEqual(web.decidirBusqueda('quien fue san martin', { perfil: 'consulta' }), {
      buscar: true,
      forzar: false,
    });
  });

  test('un dato que cambia con el tiempo se busca ANTES de responder', () => {
    for (const m of ['a cuantos esta el dolar hoy', 'quien gano el partido de ayer', 'cual es el clima manana']) {
      assert.deepEqual(web.decidirBusqueda(m, { perfil: 'consulta' }), { buscar: true, forzar: true }, m);
    }
  });

  test('si el usuario lo pide explícitamente, se busca antes de responder', () => {
    for (const m of ['buscame quien fue san martin', 'googlea la capital de australia', 'investiga sobre el amazonas']) {
      assert.deepEqual(web.decidirBusqueda(m, { perfil: 'consulta' }), { buscar: true, forzar: true }, m);
    }
  });

  test('los datos de la comunidad NUNCA se buscan afuera (manda la base del server)', () => {
    for (const m of [
      'que reglas tiene el server',
      'puedo publicar mi discord en el chat',
      'cuantos jugadores hay en el mix',
      'como funciona el sistema de niveles y logros',
      'cuanto dura el timeout por 3 warns',
      'que ip tiene el servidor de cs 1.6',
    ]) {
      assert.deepEqual(web.decidirBusqueda(m, { perfil: 'consulta' }), { buscar: false, forzar: false }, m);
    }
  });

  test('la charla social no gasta ninguna búsqueda', () => {
    assert.deepEqual(web.decidirBusqueda('hola', { perfil: 'charla' }), { buscar: false, forzar: false });
    assert.deepEqual(web.decidirBusqueda('gracias!', { perfil: 'charla' }), { buscar: false, forzar: false });
  });

  test('cotización y clima se buscan siempre antes de responder', () => {
    for (const m of ['a cuanto esta el dolar hoy', 'como esta el dolar', 'va a llover en rosario', 'clima en cordoba']) {
      assert.deepEqual(web.decidirBusqueda(m, { perfil: 'consulta' }), { buscar: true, forzar: true }, m);
    }
  });

  test('clasificarConsulta separa comunidad, general y charla', () => {
    assert.equal(web.clasificarConsulta('que reglas tiene el server', { perfil: 'consulta' }), 'comunidad');
    assert.equal(web.clasificarConsulta('messi cuantos anios tiene', { perfil: 'consulta' }), 'general');
    assert.equal(web.clasificarConsulta('hola', { perfil: 'charla' }), 'charla');
    assert.equal(
      web.clasificarConsulta('che, contame algo', { perfil: 'consulta' }),
      'comunidad',
      'ante la duda gana comunidad: es preferible inyectar la base de más'
    );
  });

  test('simplificar deja solo las palabras con contenido', () => {
    assert.equal(web.simplificar('¿Cuántos años tiene Messi?'), 'anos messi');
    assert.equal(web.simplificar('quien fue san martin'), 'san martin');
    assert.equal(web.simplificar('que hora es'), 'hora');
  });

  test('ciudadDe extrae la ciudad y descarta el ruido', () => {
    assert.equal(web.ciudadDe('clima en Rosario mañana'), 'Rosario');
    assert.equal(web.ciudadDe('va a llover en Buenos Aires hoy?'), 'Buenos Aires');
    assert.equal(web.ciudadDe('clima en San Miguel de Tucumán'), 'San Miguel de Tucumán');
    assert.equal(web.ciudadDe('va a llover hoy?'), '', 'sin ciudad no se consulta nada');
  });
});
describe('fuentes especializadas — datos que la IA no puede saber', () => {
  test('cotización del dólar: se consulta en vivo y el dato llega formateado', async () => {
    const { impl, pedidas } = fetchFalso({ dolar: COTIZACION });
    web.usarFetch(impl);

    const [resultado] = await web.buscar('a cuanto esta el dolar hoy');
    assert.equal(resultado.fuente, 'Bluelytics');
    assert.match(resultado.texto, /blue: compra \$1524 \/ venta \$1558/i);
    assert.match(resultado.texto, /oficial: compra \$1482 \/ venta \$1537/i);
    assert.ok(pedidas.some((u) => u.includes('bluelytics')));
  });

  test('clima: geocodifica la ciudad y trae el pronóstico de hoy y mañana', async () => {
    const { impl, pedidas } = fetchFalso({ geo: GEO_ROSARIO, meteo: PRONOSTICO });
    web.usarFetch(impl);

    const [resultado] = await web.buscar('va a llover en rosario manana');
    assert.equal(resultado.fuente, 'Open-Meteo');
    assert.match(resultado.titulo, /Rosario/);
    assert.match(resultado.texto, /Ahora: 17°C/);
    assert.match(resultado.texto, /Hoy: 18\.9°C \/ 7\.9°C \(lluvia 0%\)/);
    assert.match(resultado.texto, /\(lluvia 40%\)/);
    assert.ok(pedidas.some((u) => u.includes('latitude=-32.94')));
  });

  test('sin ciudad clara no se pide el clima (mejor nada que otra ciudad)', async () => {
    const { impl, pedidas } = fetchFalso({ geo: GEO_ROSARIO, meteo: PRONOSTICO });
    web.usarFetch(impl);
    assert.deepEqual(await web.buscarClima('va a llover hoy?'), []);
    assert.equal(pedidas.length, 0);
  });

  test('si la fuente especializada falla, se sigue con las demás', async () => {
    const { impl } = fetchFalso({ wiki: PAGINA_WIKI });
    web.usarFetch(impl);
    const [resultado] = await web.buscar('a cuanto esta el dolar hoy');
    assert.equal(resultado.fuente, 'Wikipedia', 'la caída de Bluelytics no rompe la búsqueda');
  });
});

describe('pareceSinInfo — detecta el "no lo tengo cargado"', () => {
  test('reconoce las negativas típicas', () => {
    for (const t of [
      'Eso no lo tengo cargado. Podés usar /help o abrir un ticket de soporte.',
      'No tengo esa información.',
      'No puedo responder eso.',
      'Lo siento, no tengo datos de eso.',
    ]) {
      assert.equal(web.pareceSinInfo(t), true, t);
    }
  });

  test('una respuesta real o larga no se toma como negativa', () => {
    assert.equal(web.pareceSinInfo('Messi nació el 24 de junio de 1987 en Rosario.'), false);
    assert.equal(web.pareceSinInfo(''), false);
    assert.equal(web.pareceSinInfo(null), false);
    // Un texto largo puede mencionar que no sabe algo al pasar: no es una negativa.
    assert.equal(web.pareceSinInfo(`${'blah '.repeat(100)}no tengo esa info`), false);
  });
});

describe('formatear — el bloque que viaja al prompt', () => {
  test('cita la fuente, el título y la url', () => {
    const bloque = web.formatear([
      { fuente: 'Wikipedia', titulo: 'Lionel Messi', texto: 'Nació en Rosario.', url: 'https://es.wikipedia.org/wiki/Lionel_Messi' },
    ]);
    assert.match(bloque, /- \[Wikipedia\] Lionel Messi: Nació en Rosario\./);
    assert.match(bloque, /https:\/\/es\.wikipedia\.org\/wiki\/Lionel_Messi/);
    assert.equal(web.formatear([]), '');
    assert.equal(web.formatear(null), '');
  });

  test('formatearFuentes cita hasta 3 fuentes, sin repetir la misma URL', () => {
    const resultados = [
      { fuente: 'Wikipedia', titulo: 'A', texto: 'x', url: 'https://es.wikipedia.org/wiki/A' },
      { fuente: 'Wikipedia', titulo: 'A bis', texto: 'x', url: 'https://es.wikipedia.org/wiki/A' },
      { fuente: 'Bluelytics', titulo: 'Dólar', texto: 'y', url: 'https://bluelytics.com.ar/' },
      { fuente: 'Web', titulo: 'C', texto: 'z', url: 'https://ejemplo.com/c' },
      { fuente: 'Web', titulo: 'D', texto: 'w', url: 'https://ejemplo.com/d' },
    ];
    const bloque = web.formatearFuentes(resultados);
    assert.match(bloque, /^🔎 Fuentes: /);
    assert.match(bloque, /\[Wikipedia\]\(https:\/\/es\.wikipedia\.org\/wiki\/A\)/);
    assert.match(bloque, /\[Bluelytics\]/);
    assert.ok(!bloque.includes('ejemplo.com/d'), 'no pasa de 3 fuentes');
    assert.equal((bloque.match(/https?:\/\//g) || []).length, 3, 'tres fuentes en total');
    assert.equal((bloque.match(/wikipedia\.org/g) || []).length, 1, 'la URL repetida se cita una vez');
    assert.equal(web.formatearFuentes([]), '');
    assert.equal(web.formatearFuentes(null), '');
    assert.equal(web.formatearFuentes([{ fuente: 'Web', texto: 'sin url' }]), '🔎 Fuentes: Web');
  });

  test('respeta el techo de tamaño del bloque', () => {
    const resultados = Array.from({ length: 20 }, (_, i) => ({
      fuente: 'Web',
      titulo: `resultado ${i}`,
      texto: 'x'.repeat(600),
      url: `https://ejemplo.com/${i}`,
    }));
    const bloque = web.formatear(resultados);
    assert.ok(bloque.length < web.MAX_BLOQUE + 600, `bloque de ${bloque.length} caracteres`);
    assert.ok(bloque.split('\n').length < 20, 'recorta la cantidad de resultados');
  });
});

describe('buscar — fuentes reales y costos', () => {
  test('trae la intro de Wikipedia y cachea la consulta', async () => {
    const { impl, pedidas } = fetchFalso({ wiki: PAGINA_WIKI });
    web.usarFetch(impl);

    const resultados = await web.buscar('messi cuantos anios tiene');
    assert.equal(resultados.length, 1);
    assert.equal(resultados[0].fuente, 'Wikipedia');
    assert.equal(resultados[0].titulo, 'Lionel Messi');
    assert.match(resultados[0].texto, /24 de junio de 1987/);
    const llamadas = pedidas.length;
    assert.ok(llamadas >= 3, 'consulta las tres fuentes en paralelo');

    // La misma pregunta dentro del TTL no vuelve a salir a la red.
    const otra = await web.buscar('messi cuantos anios tiene');
    assert.deepEqual(otra, resultados);
    assert.equal(pedidas.length, llamadas, 'la segunda vez sale de la caché');
  });

  test('parsea los resultados de DuckDuckGo Lite y desenvuelve la redirección', async () => {
    const lite = `
      <table>
        <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fes.wikipedia.org%2Fwiki%2FJos%C3%A9_de_San_Mart%C3%ADn&amp;rut=abc" class='result-link'>José de San Martín - Wikipedia</a></td></tr>
        <tr><td class='result-snippet'>José Francisco de San Martín (Yapeyú, 25 de febrero de 1778) fue un militar argentino.</td></tr>
      </table>`;

    web.usarFetch(async () => html(lite));
    const parseados = await web.buscarDuckLite('quien fue san martin');
    assert.equal(parseados.length, 1);
    assert.equal(parseados[0].titulo, 'José de San Martín - Wikipedia');
    // La redirección de DDG (/l/?uddg=…) se desenvuelve y queda la URL real.
    assert.equal(parseados[0].url, 'https://es.wikipedia.org/wiki/José_de_San_Martín');
    assert.match(parseados[0].texto, /25 de febrero de 1778/);

    // Una página sin resultados (o con el HTML cambiado) devuelve vacío, no basura.
    web.usarFetch(async () => html('<html><body>sin resultados</body></html>'));
    assert.deepEqual(await web.buscarDuckLite('quien fue san martin'), []);
  });

  test('si en español no hay nada, prueba la Wikipedia en inglés', async () => {
    const EN = { query: { pages: { 1: { index: 1, title: 'Ada Lovelace', extract: 'Augusta Ada King (10 December 1815 – 27 November 1852) was an English mathematician.', fullurl: 'https://en.wikipedia.org/wiki/Ada_Lovelace' } } } };
    const { impl } = fetchFalso({ wikiEn: EN });
    web.usarFetch(impl);

    const resultados = await web.buscar('ada lovelace quien fue');
    assert.equal(resultados.length, 1);
    assert.equal(resultados[0].fuente, 'Wikipedia (en)');
    assert.equal(resultados[0].titulo, 'Ada Lovelace');

    // Y cuando la española responde, no se gasta el viaje a la inglesa.
    const { impl: conEspanol, pedidas } = fetchFalso({ wiki: PAGINA_WIKI, wikiEn: EN });
    web.usarFetch(conEspanol);
    await web.buscar('otra consulta distinta');
    assert.equal(pedidas.filter((u) => u.includes('en.wikipedia.org')).length, 0);
  });

  test('si todas las fuentes fallan devuelve vacío y no rompe', async () => {
    web.usarFetch(async () => {
      throw new Error('sin internet');
    });
    assert.deepEqual(await web.buscar('una pregunta cualquiera de cultura general'), []);
  });

  test('respuestaSinIA arma el texto citando la fuente (cuando no hay IA)', async () => {
    const { impl } = fetchFalso({ wiki: PAGINA_WIKI });
    web.usarFetch(impl);

    const texto = await web.respuestaSinIA('messi cuantos anios tiene');
    assert.match(texto, /🔎/);
    assert.match(texto, /Wikipedia/);
    assert.match(texto, /Lionel Messi/);
    assert.match(texto, /24 de junio de 1987/);
    assert.match(texto, /es\.wikipedia\.org/);
  });

  test('no busca para el mismo usuario dentro del cooldown', async () => {
    const { impl, pedidas } = fetchFalso({ wiki: PAGINA_WIKI });
    web.usarFetch(impl);

    const primera = await web.buscar('consulta uno distinta', { usuarioId: 'u-1' });
    assert.ok(primera.length >= 1);
    const llamadas = pedidas.length;

    const segunda = await web.buscar('consulta dos distinta', { usuarioId: 'u-1' });
    assert.deepEqual(segunda, [], 'el cooldown por usuario frena la segunda');
    assert.equal(pedidas.length, llamadas, 'y no gasta ninguna llamada de red');
  });

  test('investiga: si la pregunta entera no trae nada, reintenta con los términos pelados', async () => {
    const pedidas = [];
    web.usarFetch(async (url) => {
      const u = String(url);
      pedidas.push(u);
      if (u.includes('es.wikipedia.org') && consultaWiki(u) === 'anos messi') return json(PAGINA_WIKI);
      return json({}, 500);
    });

    const resultados = await web.buscar('cuantos anos tiene messi?');
    assert.equal(resultados.length, 1);
    assert.equal(resultados[0].titulo, 'Lionel Messi');
    assert.ok(
      pedidas.some((u) => consultaWiki(u) === 'cuantos anos tiene messi?'),
      'primero prueba la pregunta tal como la escribió el usuario'
    );
    assert.ok(pedidas.some((u) => u.includes('en.wikipedia.org')), 'después la Wikipedia en inglés');
    assert.ok(
      pedidas.some((u) => consultaWiki(u) === 'anos messi'),
      'y al final la consulta reducida a sus palabras con contenido'
    );
  });

  test('no reintenta con la consulta simplificada si la original ya trajo algo', async () => {
    const { impl, pedidas } = fetchFalso({ wiki: PAGINA_WIKI });
    web.usarFetch(impl);
    await web.buscar('quien fue messi');
    assert.equal(pedidas.length, 3, 'una sola ronda: no se gasta nada de más');
  });

  test('dos pedidos simultáneos de la misma consulta salen a internet una sola vez', async () => {
    let llamadas = 0;
    web.usarFetch(async (url) => {
      llamadas += 1;
      await new Promise((r) => {
        const t = setTimeout(r, 10);
        t.unref?.();
      });
      return String(url).includes('es.wikipedia.org') ? json(PAGINA_WIKI) : json({}, 500);
    });

    const [a, b] = await Promise.all([web.buscar('consulta simultanea'), web.buscar('consulta simultanea')]);
    assert.deepEqual(a, b);
    assert.equal(llamadas, 3, 'las tres fuentes de la primera ronda, una vez');
  });

  test('verificar() prueba internet de verdad y guarda el resultado para /diag', async () => {
    const { impl, pedidas } = fetchFalso({ wiki: PAGINA_WIKI });
    web.usarFetch(impl);

    const prueba = await web.verificar({ forzar: true });
    assert.equal(prueba.ok, true);
    assert.equal(prueba.fuente, 'Wikipedia');
    assert.ok(Number.isFinite(prueba.ms));
    assert.equal(web.estadoVerificacion().ok, true, 'el resultado queda a mano para /diag');
    const llamadas = pedidas.length;

    // Segunda llamada dentro del minuto: sale del cache, sin otro pedido.
    const repetida = await web.verificar();
    assert.equal(repetida.cuando, prueba.cuando);
    assert.equal(pedidas.length, llamadas, 'no se repite el pedido');
  });

  test('verificar() informa el motivo cuando no hay salida a internet', async () => {
    web.usarFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND es.wikipedia.org');
    });

    const prueba = await web.verificar({ forzar: true });
    assert.equal(prueba.ok, false);
    assert.match(prueba.motivo, /ENOTFOUND/);
  });

  test('una consulta vacía o muy corta no busca', async () => {
    web.usarFetch(async () => {
      throw new Error('no debería llamarse');
    });
    assert.deepEqual(await web.buscar(''), []);
    assert.deepEqual(await web.buscar('ab'), []);
  });
});
