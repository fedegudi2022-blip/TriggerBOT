// Invariantes de la guía /help.
//
// La guía se armó para no desincronizarse nunca: las listas salen de las categorías y de
// los comandos cargados, y la visibilidad es "fail-safe" (un comando es de staff salvo que
// esté declarado público). Estos tests fijan las dos mitades de esa promesa, más las cosas
// que Discord rechaza si se pasan de tamaño.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-guia-'));

const { cargarComandos } = require('../src/commandLoader');
const { construirGuia, construirGuiaStaff, esPublico, esSlash, CATEGORIAS_PUBLICAS, CATEGORIAS_STAFF } = require('../src/utils/guia');

const comandos = cargarComandos();
const client = { commands: new Map(comandos.map((c) => [c.data.name, c])), user: { username: 'Trigger' } };
const slash = comandos.filter(esSlash);
const deStaff = slash.filter((c) => !esPublico(c)).map((c) => c.data.name);

const textoDe = (embed) => [embed.data.title, embed.data.description, ...(embed.data.fields ?? []).map((f) => `${f.name}\n${f.value}`)].join('\n');
const publica = () => textoDe(construirGuia(client));
const completa = () => textoDe(construirGuiaStaff(client));

// Nombres de comando citados como `/algo` entre backticks, la forma en que la guía los
// lista. Se aceptan `palabras` después del nombre (`/servidores → publicar`) porque es
// igual de visible que listarlo; lo que no cuenta es una mención suelta en el texto.
const mencionados = (texto) => [...texto.matchAll(/`\/([a-z0-9-]+)(?=[\s`])/g)].map((m) => m[1]);
const repetidos = (lista) => [...new Set(lista.filter((n, i) => lista.indexOf(n) !== i))];

describe('guía de /help', () => {
  test('ningún comando de staff se filtra a la guía pública', () => {
    const texto = publica();
    const filtrados = deStaff.filter((nombre) => texto.includes(`\`/${nombre}\``));
    assert.deepEqual(filtrados, [], `se filtraron a la guía pública: ${filtrados.join(', ')}`);
  });

  test('ningún comando público queda afuera de la guía', () => {
    const texto = publica();
    const publicos = slash.filter(esPublico).map((c) => c.data.name);
    const faltantes = publicos.filter((nombre) => !texto.includes(`\`/${nombre}\``));
    assert.deepEqual(faltantes, [], `no aparecen en la guía pública: ${faltantes.join(', ')}`);
    assert.ok(publicos.length >= 25, `se esperaban al menos 25 comandos públicos, hay ${publicos.length}`);
  });

  test('la guía pública no menciona ningún comando de staff en su texto', () => {
    // Esto es lo que atrapa al texto escrito a mano: una nota o un texto de intro que
    // nombre un comando de staff filtra su existencia en la guía pública.
    const fugas = [...new Set(mencionados(publica()).filter((nombre) => deStaff.includes(nombre)))];
    assert.deepEqual(fugas, [], `el texto público menciona comandos de staff: ${fugas.join(', ')}`);
  });

  test('ningún comando se lista dos veces en la misma guía', () => {
    for (const [cual, texto] of [['pública', publica()], ['de staff', completa()]]) {
      const dobles = repetidos(mencionados(texto));
      assert.deepEqual(dobles, [], `comandos repetidos en la guía ${cual}: ${dobles.join(', ')}`);
    }
  });

  test('la guía de staff menciona cada comando slash cargado', () => {
    const texto = completa();
    const faltantes = slash.map((c) => c.data.name).filter((nombre) => !texto.includes(`\`/${nombre}\``));
    assert.deepEqual(faltantes, [], `no aparecen en la guía de staff: ${faltantes.join(', ')}`);
  });

  test('cada categoría nombra comandos que existen', () => {
    // Una categoría con un nombre mal escrito se ignora en silencio, así que la guía
    // perdería el comando sin que nada falle.
    const reclamados = [...CATEGORIAS_PUBLICAS, ...CATEGORIAS_STAFF].flatMap((c) => c.comandos ?? []);
    const inexistentes = reclamados.filter((nombre) => !client.commands.has(nombre));
    assert.deepEqual(inexistentes, [], `las categorías nombran comandos que no existen: ${inexistentes.join(', ')}`);
  });

  test('un comando no está en dos categorías públicas a la vez', () => {
    const dobles = repetidos(CATEGORIAS_PUBLICAS.flatMap((c) => c.comandos ?? []));
    assert.deepEqual(dobles, [], `repetidos entre categorías públicas: ${dobles.join(', ')}`);
  });

  test('todo comando que pide staff con exigirStaff queda fuera de la guía pública', () => {
    // La regla es al revés que la lista negra que había antes: un comando nuevo que pide
    // staff no necesita que nadie se acuerde de declararlo "de staff" para quedar oculto.
    // Y si alguien lo suma por error a una categoría pública, esto lo delata.
    const dir = path.join(__dirname, '..', 'src', 'commands');
    const conStaff = fs
      .readdirSync(dir)
      .filter((archivo) => archivo.endsWith('.js'))
      .filter((archivo) => fs.readFileSync(path.join(dir, archivo), 'utf8').includes('exigirStaff('))
      .map((archivo) => path.basename(archivo, '.js'));

    const publicos = new Set(slash.filter(esPublico).map((c) => c.data.name));
    const mal = conStaff.filter((nombre) => publicos.has(nombre));
    assert.deepEqual(mal, [], `piden staff y están declarados públicos: ${mal.join(', ')}`);
    assert.ok(conStaff.length >= 20, `se esperaban al menos 20 comandos con exigirStaff, hay ${conStaff.length}`);
  });

  test('ningún campo se pasa de lo que acepta Discord', () => {
    for (const [cual, embed] of [['pública', construirGuia(client)], ['de staff', construirGuiaStaff(client)]]) {
      const campos = embed.data.fields ?? [];
      assert.ok(campos.length <= 25, `la guía ${cual} tiene ${campos.length} campos`);
      for (const campo of campos) {
        assert.ok(campo.name.length <= 256, `nombre de campo muy largo en la guía ${cual}: ${campo.name}`);
        assert.ok(campo.value.length <= 1024, `el campo "${campo.name}" de la guía ${cual} tiene ${campo.value.length} caracteres`);
      }
    }
  });
});
