// Tests de la base de conocimiento (utils/conocimiento.js).
// Todo con archivos temporales: no toca docs/conocimiento salvo el último bloque,
// que valida que el contenido REAL que se distribuye responde las preguntas típicas.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// El buscador semántico cachea sus vectores en el directorio de datos: en los tests va a
// un temporal para no tocar el data/embeddings.json del proyecto. Y la semántica arranca
// apagada: el bloque que la prueba la prende con un proveedor falso (cero red).
process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-kb-data-'));
process.env.KB_SEMANTICO = 'off';
delete process.env.GEMINI_API_KEY;

const conocimiento = require('../src/utils/conocimiento');
const embeddings = require('../src/utils/embeddings');

const DIRECTORIO = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-kb-'));

function escribir(nombre, contenido) {
  fs.writeFileSync(path.join(DIRECTORIO, nombre), contenido, 'utf8');
}

escribir(
  'conectar.md',
  [
    '# Conectarse',
    '',
    '## Cómo entro a un servidor',
    'Abrí la consola con la tecla ~ y escribí connect IP.',
    '',
    '## Qué es un mix',
    'Partidas armadas y organizadas con equipos.',
    '',
  ].join('\n')
);
escribir(
  'moderacion.md',
  [
    '# Moderación',
    '',
    '## Silencio y baneo',
    'El baneo es definitivo hasta que lo revoquen con unban.',
    'El rol Silenciado es indefinido: dura hasta que lo quiten.',
    '',
  ].join('\n')
);
escribir('_borrador.md', '## No debe indexarse\nTexto oculto secreto.\n');
escribir('README.md', '## Instrucciones de carga\nEsto no es conocimiento.\n');

after(() => {
  fs.rmSync(DIRECTORIO, { recursive: true, force: true });
  fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true });
});

const opciones = { directorio: DIRECTORIO };

describe('conocimiento — armado de secciones', () => {
  test('cada "## Título" es una sección y el H1 no se indexa', () => {
    const secciones = conocimiento.buscar('silencio baneo', opciones);
    assert.equal(secciones.length, 1);
    assert.equal(secciones[0].titulo, 'Silencio y baneo');
    assert.equal(secciones[0].archivo, 'moderacion.md');
  });

  test('ignora README.md y los archivos que empiezan con "_"', () => {
    assert.deepEqual(conocimiento.buscar('instrucciones de carga', opciones), []);
    assert.deepEqual(conocimiento.buscar('texto oculto secreto', opciones), []);
  });

  test('cuenta las secciones y archivos cargados', () => {
    const stats = conocimiento.estadisticas(DIRECTORIO);
    assert.equal(stats.secciones, 3);
    assert.deepEqual(stats.archivos, ['conectar.md', 'moderacion.md']);
  });
});

describe('conocimiento — búsqueda', () => {
  test('encuentra la sección correcta para una pregunta natural', () => {
    const [mejor] = conocimiento.buscar('como hago para entrar a un servidor', opciones);
    assert.ok(mejor, 'debería encontrar algo');
    assert.equal(mejor.titulo, 'Cómo entro a un servidor');
  });

  test('no le afectan tildes ni mayúsculas', () => {
    const [mejor] = conocimiento.buscar('CÓMO ENTRÓ AL SERVIDOR????', opciones);
    assert.ok(mejor);
    assert.equal(mejor.titulo, 'Cómo entro a un servidor');
  });

  test('las claves de raíz hacen que "banear" encuentre "baneo"', () => {
    const [mejor] = conocimiento.buscar('me pueden banear para siempre?', opciones);
    assert.ok(mejor);
    assert.equal(mejor.titulo, 'Silencio y baneo');
  });

  test('pregunta sin relación → array vacío (y la IA dirá que no sabe)', () => {
    assert.deepEqual(conocimiento.buscar('cuánto cuesta la pizza de muzzarella', opciones), []);
    assert.deepEqual(conocimiento.buscar('', opciones), []);
  });

  test('respeta el límite de fragmentos y el umbral relativo', () => {
    const todos = conocimiento.buscar('servidor', { ...opciones, minimo: 0 });
    assert.ok(todos.length <= conocimiento.LIMITE_POR_DEFECTO);
  });

  test('contextoPara devuelve el texto formateado con el título', () => {
    const texto = conocimiento.contextoPara('como entro a un servidor', opciones);
    assert.match(texto, /^### Cómo entro a un servidor/);
    assert.match(texto, /connect IP/);
  });

  test('contextoPara devuelve cadena vacía si no hay nada cargado', () => {
    assert.equal(conocimiento.contextoPara('pizza de muzzarella', opciones), '');
  });
});

describe('conocimiento — recarga y límites', () => {
  test('un archivo nuevo aparece con forzar: true (el TTL lo dejaría cacheado)', () => {
    assert.deepEqual(conocimiento.buscar('torneos de la comunidad', opciones), []);

    escribir('torneos.md', '## Torneos de la comunidad\nSe juegan los domingos a las 21.\n');
    assert.deepEqual(conocimiento.buscar('torneos de la comunidad', opciones), [], 'sin forzar sigue la cache');

    const [nuevo] = conocimiento.buscar('torneos de la comunidad', { ...opciones, forzar: true });
    assert.ok(nuevo);
    assert.equal(nuevo.titulo, 'Torneos de la comunidad');
  });

  test('recortar secciones gigantes para no inflar el prompt', () => {
    const largo = '## Sección larga\n' + 'palabra '.repeat(400); // ~2.800 caracteres
    escribir('largo.md', largo);
    const [seccion] = conocimiento.buscar('sección larga palabra', { ...opciones, forzar: true });
    assert.ok(seccion.texto.length <= 1201, `quedó en ${seccion.texto.length}`);
    assert.ok(seccion.texto.endsWith('…'));
  });

  test('directorio inexistente no rompe: devuelve vacío', () => {
    assert.deepEqual(conocimiento.buscar('hola', { directorio: path.join(DIRECTORIO, 'no-existe') }), []);
  });
});

describe('conocimiento — contenido real distribuido', () => {
  const real = { directorio: conocimiento.DIRECTORIO_POR_DEFECTO, forzar: true };

  test('responde las dudas típicas del servidor', () => {
    const casos = [
      ['cuanto xp necesito para el nivel 10', 'niveles.md'],
      ['como entro al servidor de cs 1.6', 'conectar.md'],
      ['como abro un ticket de soporte', 'soporte.md'],
      ['que pasa si me dan 3 warns', 'moderacion.md'],
      ['me pueden banear para siempre', 'moderacion.md'],
      ['cual es la web oficial', 'comunidad.md'],
      ['que comandos tiene el bot', 'bot.md'],
    ];
    for (const [pregunta, archivo] of casos) {
      const encontrados = conocimiento.buscar(pregunta, real);
      assert.ok(encontrados.length, `debería encontrar algo para "${pregunta}"`);
      assert.ok(
        encontrados.some((s) => s.archivo === archivo),
        `"${pregunta}" debería traer ${archivo} (trajo: ${encontrados.map((s) => s.archivo).join(', ')})`
      );
    }
  });

  test('las normativas están cargadas: las 12 normas, con sus temas clave', () => {
    const contenido = fs.readFileSync(path.join(conocimiento.DIRECTORIO_POR_DEFECTO, 'reglas.md'), 'utf8');
    for (let n = 1; n <= 12; n++) {
      assert.match(contenido, new RegExp(`^## Norma ${n} — `, 'm'), `falta la norma ${n}`);
    }
    for (const tema of ['Respeto', 'gore', 'publicidad', 'canales', 'toxicidad', 'pings', 'Cheats', 'Suplantación', 'Evasión', 'Staff', 'Sanciones']) {
      assert.match(contenido, new RegExp(tema, 'i'), `falta el tema "${tema}"`);
    }
    assert.match(contenido, /cuentas alternativas/i, 'la evasión de sanciones está descripta');
  });

  test('las preguntas de las normas caen en reglas.md (y no en una respuesta inventada)', () => {
    const casos = [
      ['puedo poner publicidad?', 'Norma 3'],
      ['se puede mandar contenido +18?', 'Norma 2'],
      ['puedo usar cheats?', 'Norma 7'],
      ['puedo usar una cuenta alternativa para evadir la sancion', 'Norma 9'],
      ['me hice pasar por un admin', 'Norma 8'],
      ['se puede insultar a alguien', 'Norma 1'],
      ['que sanciones me pueden dar', 'Norma 11'],
      ['no estoy de acuerdo con una sancion', null],
      ['se puede usar el micro?', null],
    ];
    for (const [pregunta, norma] of casos) {
      const encontrados = conocimiento.buscar(pregunta, real);
      assert.ok(
        encontrados.some((s) => s.archivo === 'reglas.md'),
        `"${pregunta}" debería traer reglas.md (trajo: ${encontrados.map((s) => s.archivo).join(', ')})`
      );
      if (norma) {
        assert.ok(
          encontrados.some((s) => s.titulo.startsWith(norma)),
          `"${pregunta}" debería traer ${norma} (trajo: ${encontrados.map((s) => s.titulo).join(' | ')})`
        );
      }
    }
  });

  test('una pregunta de cultura general NO da coincidencia en el título (no se inyecta)', () => {
    // 'cuántos' aparece en títulos de la base ("Cuántos XP necesito…"): es una palabra
    // del armado de la pregunta, así que no puede contar como tema cargado. Sin esta
    // distinción, la base de la comunidad viajaba en preguntas como la edad de Messi.
    for (const pregunta of ['messi cuantos anios tiene', 'cuantos habitantes tiene japon', 'quien invento el telefono']) {
      const encontrados = conocimiento.buscar(pregunta, real);
      assert.equal(
        encontrados.some((s) => s.enTitulo),
        false,
        `"${pregunta}" no debería dar coincidencia con contenido (trajo: ${encontrados.map((s) => s.titulo).join(' | ')})`
      );
    }
  });

  test('una pregunta de la comunidad sí da coincidencia en el título', () => {
    for (const pregunta of ['cuanto xp necesito para el nivel 10', 'como abro un ticket', 'puedo poner publicidad?']) {
      const encontrados = conocimiento.buscar(pregunta, real);
      assert.ok(
        encontrados.some((s) => s.enTitulo),
        `"${pregunta}" debería dar coincidencia con contenido (trajo: ${encontrados.map((s) => s.titulo).join(' | ')})`
      );
    }
  });

  test('lo que las normas no cubren se deriva al staff (no se inventa un permiso)', () => {
    const [tema] = conocimiento.buscar('se puede usar el micro?', real);
    assert.match(tema.titulo, /no están contemplados/i);
    assert.match(tema.texto, /staff/i);
  });
});

// La búsqueda híbrida (palabras + significado) con un proveedor de embeddings falso:
// acá se prueba la MECÁNICA del ranking (candidatos, señales, umbrales y caída a BM25),
// que es lo que tiene que estar bien para que la semántica real solo mejore las respuestas.
// Va al final del archivo a propósito: el último caso deja al proveedor castigado.
describe('conocimiento — búsqueda semántica (híbrida)', () => {
  const HIBRIDO = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-kb-sem-'));
  const escribirHibrido = (nombre, contenido) => fs.writeFileSync(path.join(HIBRIDO, nombre), contenido, 'utf8');

  escribirHibrido(
    'moderacion.md',
    [
      '# Moderación',
      '',
      '## Rol Silenciado',
      'El rol Silenciado no deja escribir en el servidor.',
      '',
      '## Cómo llegan los mensajes',
      'Los mensajes privados llegan igual con el rol puesto.',
      '',
      '## Mix',
      'Partidas armadas los viernes.',
      '',
    ].join('\n')
  );

  // Prende la semántica con un proveedor falso. `vectorDe(texto, tipo)` decide el vector
  // (tipo = 'consulta' | 'documento', como en la API real); `contador` cuenta peticiones.
  function activarSemantica(vectorDe, contador = null) {
    process.env.KB_SEMANTICO = 'on';
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    embeddings.reiniciar();
    fs.rmSync(embeddings.ARCHIVO, { force: true }); // caché de disco limpia por test
    embeddings.usarFetch(async (url, opciones = {}) => {
      const peticion = JSON.parse(opciones.body);
      if (contador) contador.llamadas += 1;
      const tipo = peticion.requests[0]?.taskType === 'RETRIEVAL_QUERY' ? 'consulta' : 'documento';
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: peticion.requests.map((r) => ({ values: vectorDe(r.content.parts[0].text, tipo) })) }),
        text: async () => '',
      };
    });
  }

  after(() => {
    fs.rmSync(HIBRIDO, { recursive: true, force: true });
    delete process.env.GEMINI_API_KEY;
    process.env.KB_SEMANTICO = 'off';
    embeddings.reiniciar();
  });

  test('con KB_SEMANTICO=off devuelve exactamente lo mismo que la búsqueda por palabras', async () => {
    process.env.KB_SEMANTICO = 'off';
    for (const consulta of ['como hago para entrar a un servidor', 'cuanto cuesta la pizza de muzzarella']) {
      assert.deepEqual(await conocimiento.buscarHibrido(consulta, opciones), conocimiento.buscar(consulta, opciones), consulta);
    }
  });

  test('los umbrales se leen del entorno y un valor inválido se ignora', () => {
    process.env.KB_SEMANTICO_UMBRAL = '0.6';
    process.env.KB_SEMANTICO_TITULO = '0.9';
    assert.deepEqual(conocimiento.umbrales(), { aceptar: 0.6, titulo: 0.9 });

    process.env.KB_SEMANTICO_UMBRAL = 'mucho';
    process.env.KB_SEMANTICO_TITULO = '1.4'; // fuera de rango
    assert.deepEqual(conocimiento.umbrales(), { aceptar: conocimiento.UMBRAL_SEMANTICO_POR_DEFECTO, titulo: conocimiento.UMBRAL_TITULO_POR_DEFECTO });

    delete process.env.KB_SEMANTICO_UMBRAL;
    delete process.env.KB_SEMANTICO_TITULO;
  });

  test('encuentra por significado una sección que las palabras no encuentran', async () => {
    // La pregunta no comparte ni una palabra con la base: solo el significado del eje 0.
    activarSemantica((texto) => {
      if (/hostig|silenc/i.test(texto)) return [1, 0, 0, 0];
      if (/mensaje|privado/i.test(texto)) return [0, 1, 0, 0];
      return [0, 0, 1, 0];
    });

    const consulta = 'me hostigan zzzq';
    assert.deepEqual(conocimiento.buscar(consulta, { directorio: HIBRIDO }), [], 'sin coincidencia por palabras (es el caso que la semántica existe para resolver)');

    const fragmentos = await conocimiento.buscarHibrido(consulta, { directorio: HIBRIDO, forzar: true });

    assert.equal(fragmentos.length, 1, 'solo la sección de ese significado');
    assert.equal(fragmentos[0].titulo, 'Rol Silenciado');
    assert.equal(fragmentos[0].origen, 'semantico');
    assert.equal(fragmentos[0].similitud, 1);
    assert.equal(fragmentos[0].enTitulo, true, 'una similitud alta cuenta como tema cargado');
  });

  test('una sección que las palabras ya reconocieron en el título no gasta ninguna llamada', async () => {
    const contador = { llamadas: 0 };
    activarSemantica(() => [1, 0, 0, 0], contador);

    // Primer llamado: calcula los vectores de la base (aunque no los necesite el ranking).
    await conocimiento.buscarHibrido('hola', { directorio: DIRECTORIO, forzar: true });
    assert.ok(contador.llamadas > 0, 'la base se vectoriza de entrada');

    contador.llamadas = 0;
    const fragmentos = await conocimiento.buscarHibrido('me pueden banear para siempre?', opciones);
    assert.equal(contador.llamadas, 0, 'el camino rápido no paga red');
    assert.equal(fragmentos[0].titulo, 'Silencio y baneo');
    assert.equal(fragmentos[0].origen, 'bm25');
  });

  test('un acierto parcial queda afuera por el umbral (y con el umbral bajo entra)', async () => {
    // Todos los vectores de la base iguales y la consulta a 45°: cos 0,707.
    activarSemantica((texto, tipo) => (tipo === 'consulta' ? [1, 0, 0, 0] : [1, 1, 0, 0]));

    const alto = await conocimiento.buscarHibrido('privados', { directorio: HIBRIDO, forzar: true });
    assert.ok(alto.length, 'la coincidencia por palabras responde igual');
    assert.equal(alto[0].origen, 'bm25', '0,707 no llega al umbral de aceptación');
    assert.equal(alto[0].enTitulo, false);

    process.env.KB_SEMANTICO_UMBRAL = '0.5';
    const bajo = await conocimiento.buscarHibrido('privados', { directorio: HIBRIDO });
    assert.equal(bajo[0].origen, 'bm25+semantico', 'el umbral configurable decide');
    assert.equal(bajo[0].enTitulo, false, 'pero no alcanza para contar como tema cargado');
    delete process.env.KB_SEMANTICO_UMBRAL;
  });

  test('si el proveedor falla, la búsqueda sigue por palabras y el estado lo reporta', async () => {
    process.env.KB_SEMANTICO = 'on';
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    embeddings.reiniciar();
    fs.rmSync(embeddings.ARCHIVO, { force: true });
    embeddings.usarFetch(async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' }));

    const fragmentos = await conocimiento.buscarHibrido('privados', { directorio: HIBRIDO, forzar: true });
    assert.ok(fragmentos.length, 'BM25 responde igual (nunca se queda sin búsqueda)');
    assert.equal(fragmentos[0].origen, 'bm25');

    const estado = conocimiento.estadisticas(HIBRIDO).semantico;
    assert.equal(estado.estado, 'no-disponible');
    assert.match(estado.motivo, /en pausa/);
    assert.equal(conocimiento.estadisticas(HIBRIDO).secciones, 3, 'el índice sigue entero');
  });
});
