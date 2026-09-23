// Smoke test del registro de comandos.
//
// Por qué existe: el bot hace `git pull` + `npm install` + arranque EN CADA REINICIO.
// Si un comando queda mal armado, no hay revisión humana que lo frene: Discord rechaza
// el registro completo (con todos los comandos, uno inválido deja el bot sin NINGUNO) o el
// cargador lo saltea en silencio y el comando desaparece sin que nadie se entere.
//
// Acá se valida el payload REAL (`data.toJSON()`), es decir exactamente lo que se le
// manda a Discord, contra las reglas que exige su API.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-reg-'));

const { cargarComandos, fallosDeCarga } = require('../src/commandLoader');
const { construirGuia, construirGuiaStaff } = require('../src/utils/guia');

// ---------- Reglas de Discord ----------
// Copiadas de @discordjs/builders (namePredicate) y de los límites documentados de
// la API: son las que hacen que el registro falle en producción.
const RE_NOMBRE = /^[\p{Ll}\p{Lm}\p{Lo}\p{N}\p{sc=Devanagari}\p{sc=Thai}_-]+$/u;
const MAX_NOMBRE = 32;
const MAX_DESCRIPCION = 100;
const MAX_OPCIONES = 25;
const MAX_ELECCIONES = 25;
const TIPOS_CON_ELECCIONES = [3, 4, 10]; // STRING, INTEGER, NUMBER
const SUBCOMANDO = 1;
const GRUPO = 2;

const comandos = cargarComandos();

// ---------- Recorrido del payload ----------
function revisarOpciones(opciones, ruta, problemas) {
  assert.ok(Array.isArray(opciones), `${ruta} tiene que ser una lista`);

  if (opciones.length > MAX_OPCIONES) {
    problemas.push(`${ruta}: ${opciones.length} opciones (el máximo es ${MAX_OPCIONES})`);
  }

  const vistos = new Set();
  for (const opcion of opciones) {
    const donde = `${ruta} → ${opcion?.name ?? '(sin nombre)'}`;

    if (!opcion?.name || !RE_NOMBRE.test(opcion.name) || opcion.name.length > MAX_NOMBRE) {
      problemas.push(`${donde}: nombre inválido (1-${MAX_NOMBRE}, minúsculas, números, - y _)`);
    }
    if (vistos.has(opcion?.name)) problemas.push(`${donde}: nombre repetido en el mismo nivel`);
    vistos.add(opcion?.name);

    const descripcion = opcion?.description;
    if (typeof descripcion !== 'string' || !descripcion.length || descripcion.length > MAX_DESCRIPCION) {
      problemas.push(`${donde}: descripción inválida (1-${MAX_DESCRIPCION} caracteres, tiene ${descripcion?.length ?? 0})`);
    }
    if (typeof opcion?.type !== 'number') problemas.push(`${donde}: sin tipo`);

    if (opcion?.choices) {
      if (!TIPOS_CON_ELECCIONES.includes(opcion.type)) {
        problemas.push(`${donde}: tiene choices pero su tipo no las admite`);
      }
      if (opcion.choices.length > MAX_ELECCIONES) {
        problemas.push(`${donde}: ${opcion.choices.length} choices (el máximo es ${MAX_ELECCIONES})`);
      }
      for (const eleccion of opcion.choices) {
        if (!eleccion?.name || eleccion.name.length > MAX_DESCRIPCION) problemas.push(`${donde}: choice con nombre inválido`);
      }
    }

    if (opcion?.type === SUBCOMANDO || opcion?.type === GRUPO) {
      revisarOpciones(opcion.options ?? [], donde, problemas);
    }
  }

  // Discord no acepta mezclar subcomandos con grupos de subcomandos en el mismo nivel.
  const tipos = new Set(opciones.map((o) => o?.type));
  if (tipos.has(SUBCOMANDO) && tipos.has(GRUPO)) {
    problemas.push(`${ruta}: mezcla subcomandos con grupos de subcomandos`);
  }
}

function revisarComando(comando) {
  const problemas = [];
  const json = comando.data.toJSON();
  const nombre = json.name;

  if (!nombre || !RE_NOMBRE.test(nombre) || nombre.length > MAX_NOMBRE) {
    problemas.push(`${nombre ?? '(sin nombre)'}: nombre inválido`);
  }
  const descripcion = json.description;
  if (typeof descripcion !== 'string' || !descripcion.length || descripcion.length > MAX_DESCRIPCION) {
    problemas.push(`${nombre}: descripción inválida (tiene ${descripcion?.length ?? 0}, el máximo es ${MAX_DESCRIPCION})`);
  }

  revisarOpciones(json.options ?? [], `/${nombre}`, problemas);
  return { nombre, json, problemas };
}

const revisados = comandos.map(revisarComando);

// Todo el texto visible de un embed (títulos, descripciones y campos).
const textoDe = (embed) =>
  [embed.data.title, embed.data.description, ...(embed.data.fields ?? []).map((f) => `${f.name}\n${f.value}`)]
    .filter(Boolean)
    .join('\n');

function clientFake() {
  const commands = new Map();
  for (const comando of comandos) commands.set(comando.data.name, comando);
  return { commands, user: { username: 'Trigger' } };
}

describe('registro de comandos (payload real para Discord)', () => {
  test('todos los comandos se cargan y ninguno queda salteado en silencio', () => {
    // El cargador SIGUE si un módulo no exporta data/execute o si directamente tira
    // al requerirse: el comando desaparecería del bot sin que nada falle a la vista.
    // Acá se cuenta a mano, archivo por archivo, y se compara con lo cargado.
    const dir = path.join(__dirname, '..', 'src', 'commands');
    const archivos = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((archivo) => {
        try {
          return { archivo, modulo: require(path.join(dir, archivo)) };
        } catch (error) {
          return { archivo, error };
        }
      });

    const rotos = archivos.filter((a) => a.error);
    assert.deepEqual(
      rotos.map((a) => `${a.archivo}: ${a.error.message}`),
      [],
      'estos módulos tiran al cargarse (el bot arrancaría sin ellos)'
    );

    const directos = archivos.filter(({ modulo }) => 'data' in modulo && 'execute' in modulo);
    const { comandos: generados } = require('../src/utils/fabricaInteracciones');
    const esperados = directos.length + generados.length + 1; // +1 = /moneda

    assert.equal(comandos.length, esperados, 'cada módulo con data+execute tiene que llegar al registro');
    // Piso de seguridad: la lista crece con cada comando nuevo (hoy son 48). Si alguien
    // borra archivos o el cargador deja de recorrer el directorio, el conteo dinámico
    // todavía "cuadra" pero el bot se queda sin comandos: esto lo delata.
    assert.ok(comandos.length >= 48, `se esperaban al menos 48 comandos, hay ${comandos.length}`);
    assert.equal(new Set(comandos.map((c) => c.data.name)).size, comandos.length, 'los nombres no se repiten');
    assert.deepEqual(fallosDeCarga(), [], 'el cargador no debe haber salteado ningún archivo');
  });

  test('cada comando cumple las reglas de Discord (nombres, descripciones y opciones)', () => {
    const problemas = revisados.flatMap((r) => r.problemas);
    assert.deepEqual(problemas, [], `Discord rechazaría el registro:\n${problemas.join('\n')}`);
  });

  test('todas las opciones tienen nombre y descripción dentro de los límites', () => {
    for (const { nombre, json } of revisados) {
      const conOptions = json.options ?? [];
      assert.ok(conOptions.length <= MAX_OPCIONES, `/${nombre} tiene demasiadas opciones`);
      for (const opcion of conOptions) {
        assert.ok(opcion.name.length <= MAX_NOMBRE, `/${nombre} → ${opcion.name}: nombre largo`);
        assert.ok(opcion.description.length <= MAX_DESCRIPCION, `/${nombre} → ${opcion.name}: descripción larga`);
      }
    }
  });

  test('todos los comandos son ejecutables y serializables', () => {
    for (const comando of comandos) {
      assert.equal(typeof comando.execute, 'function', `/${comando.data.name} no tiene execute`);
      assert.equal(typeof comando.data.toJSON, 'function', `${comando.data.name} no es un SlashCommandBuilder`);
      assert.doesNotThrow(() => comando.data.toJSON(), `${comando.data.name} no se puede serializar`);
    }
  });
});

describe('la guía /help cubre todo lo que existe', () => {
  test('la guía de staff menciona cada comando cargado', () => {
    const texto = textoDe(construirGuiaStaff(clientFake()));
    const faltantes = comandos.map((c) => c.data.name).filter((n) => !texto.includes(`\`/${n}\``));
    assert.deepEqual(faltantes, [], `estos comandos no aparecen en /help staff: ${faltantes.join(', ')}`);
  });

  test('ningún comando con permisos restringidos aparece en la guía pública', () => {
    // Si mañana se agrega un comando de staff y se olvida sumarlo a SOLO_STAFF, se
    // filtraría en la guía pública: acá se detecta comparando con los permisos reales.
    const client = clientFake();
    const publica = textoDe(construirGuia(client));
    const filtrados = revisados
      .filter((r) => r.json.default_member_permissions != null)
      .map((r) => r.nombre)
      .filter((nombre) => publica.includes(`\`/${nombre}\``));

    assert.deepEqual(filtrados, [], `comandos de staff visibles en /help público: ${filtrados.join(', ')}`);
  });

  test('la guía pública muestra los comandos que sí son para todos', () => {
    const publica = textoDe(construirGuia(clientFake()));
    for (const nombre of ['help', 'userinfo', 'top', 'logros', 'ip', 'servidores', 'redes', 'web', 'beso']) {
      assert.ok(publica.includes(`\`/${nombre}\``), `/${nombre} debería estar en la guía pública`);
    }
  });
});
