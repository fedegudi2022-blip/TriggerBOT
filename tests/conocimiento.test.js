// Tests de la base de conocimiento (utils/conocimiento.js).
// Todo con archivos temporales: no toca docs/conocimiento salvo el último bloque,
// que valida que el contenido REAL que se distribuye responde las preguntas típicas.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const conocimiento = require('../src/utils/conocimiento');

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

after(() => fs.rmSync(DIRECTORIO, { recursive: true, force: true }));

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
