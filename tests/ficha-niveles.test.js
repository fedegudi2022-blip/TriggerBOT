// Tests de render de /estadisticas y /logros. Cubren lo que se rediseñó: la ficha dejó
// de listar los 16 logros con [x]/[ ] y /logros pasó a un renglón por logro. Cada proceso
// de test usa su propio directorio de datos.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-ficha-'));

const estadisticas = require('../src/commands/estadisticas');
const logros = require('../src/commands/logros');
const niveles = require('../src/niveles');

const GUILD = 'guild-ficha';
const YO = 'yo';

function interaccionFake(usuario = YO) {
  const capturado = {};
  return {
    capturado,
    // discord.js valida el thumbnail: tiene que ser una URL de verdad.
    options: {
      getUser: () => ({ id: usuario, username: 'fede', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png' }),
    },
    user: { id: usuario, username: 'fede' },
    guild: { id: GUILD },
    deferReply: async () => {},
    editReply: async (payload) => {
      capturado.payload = payload;
    },
  };
}

// Embed ya en JSON: es lo que el comando manda a Discord.
function embedDe(interaccion) {
  return interaccion.capturado.payload.embeds[0].data;
}

// Datos de alguien activo: nivel 12, logros ya cobrados y pendientes de todo tipo.
function sembrar(extra = {}) {
  niveles.escribir(GUILD, {
    otro: { xp: 20000, nivel: niveles.nivelDe(20000), mensajes: 800, findes: 10, racha: 4, logros: [] },
    [YO]: {
      xp: 15356,
      nivel: 12,
      mensajes: 340,
      findes: 22,
      racha: 9,
      logros: ['primer_mensaje', 'charlatan', 'finde'],
      ...extra,
    },
  });
}

const campo = (embed, nombre) => embed.fields?.find((f) => f.name.startsWith(nombre));

describe('/estadisticas, ficha de niveles', () => {
  test('no vuelve a listar los 16 logros con [x]/[ ]', async () => {
    sembrar();
    const interaccion = interaccionFake();
    await estadisticas.execute(interaccion);

    const embed = embedDe(interaccion);
    const texto = [embed.description, ...(embed.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');
    assert.ok(!texto.includes('[x]') && !texto.includes('[ ]'), 'los checkboxes de texto no van más');

    // A lo sumo los tres próximos nombran logros: la lista completa vive en /logros.
    // Se miran solo los campos: la descripción dice el rango, y "Experto" y "Veterano"
    // son rango Y nombre de logro al mismo tiempo.
    const valores = (embed.fields ?? []).map((f) => f.value).join('\n');
    const nombrados = niveles.LOGROS.filter((l) => valores.includes(l.nombre));
    assert.ok(nombrados.length <= 3, `la ficha nombra demasiados logros: ${nombrados.map((l) => l.nombre).join(', ')}`);
  });

  test('la cabecera dice rango, nivel, puesto y lo que falta en mensajes', async () => {
    sembrar();
    const interaccion = interaccionFake();
    await estadisticas.execute(interaccion);

    const embed = embedDe(interaccion);
    assert.ok(embed.description.includes('**Experto** · Nivel **12** · Puesto **#2** de 2'), embed.description);
    assert.ok(embed.description.includes('**15.356 XP** de 16.900 · faltan **1.544** (~78 mensajes)'), embed.description);
  });

  test('muestra tres próximos logros como máximo, con lo que falta', async () => {
    sembrar();
    const interaccion = interaccionFake();
    await estadisticas.execute(interaccion);

    const proximos = campo(embedDe(interaccion), 'Próximos logros');
    assert.ok(proximos, 'la ficha tiene que empujar al siguiente logro');
    const renglones = proximos.value.split('\n');
    assert.equal(renglones.length, 3);
    assert.ok(renglones.every((l) => l.includes('faltan') && l.includes('XP')), proximos.value);
    assert.ok(!proximos.value.includes('faltan **0'), 'un logro ya cumplido no se muestra como pendiente');
  });

  test('sin logros pendientes medibles no aparece el campo de próximos', async () => {
    // Todos los logros con meta, ya obtenidos.
    const conMeta = niveles.LOGROS.filter((l) => l.meta).map((l) => l.id);
    sembrar({ logros: conMeta });
    const interaccion = interaccionFake();
    await estadisticas.execute(interaccion);

    assert.equal(campo(embedDe(interaccion), 'Próximos logros'), undefined);
  });
});

describe('/logros, progreso por logro', () => {
  test('un renglón por logro pendiente, sin líneas vacías, y el count coincide', async () => {
    sembrar();
    const interaccion = interaccionFake();
    await logros.execute(interaccion);

    const embed = embedDe(interaccion);
    const enProgreso = campo(embed, 'En progreso');
    const renglones = enProgreso.value.split('\n');
    assert.ok(renglones.length > 3, 'tiene varios pendientes medibles');
    assert.ok(!enProgreso.value.includes('\n\n'), 'los logros no van separados por un renglón vacío');
    assert.ok(enProgreso.name.endsWith(`(${renglones.length})`), enProgreso.name);
    assert.ok(renglones.every((l) => l.includes('**') && l.includes('faltan')), enProgreso.value);
  });

  test('ordena del más cercano a cumplir al más lejano, por progreso', async () => {
    sembrar();
    const interaccion = interaccionFake();
    await logros.execute(interaccion);

    const pendientes = niveles.logrosConProgreso(niveles.datosDe(GUILD, YO));
    const renglones = campo(embedDe(interaccion), 'En progreso').value.split('\n');
    assert.deepEqual(
      renglones.map((l) => l.match(/\*\*(.+?)\*\*/)[1]),
      pendientes.map((p) => p.logro.nombre),
      'el orden del embed es el del cálculo compartido'
    );

    const progresos = pendientes.map((p) => p.progreso);
    assert.deepEqual(
      progresos,
      [...progresos].sort((a, b) => b - a),
      'El criterio es el porcentaje de avance, no los faltantes en crudo (21 días de racha están más lejos que 160 mensajes)'
    );
  });

  test('los desbloqueados van compactos y no ocupan un renglón cada uno', async () => {
    sembrar();
    const interaccion = interaccionFake();
    await logros.execute(interaccion);

    const embed = embedDe(interaccion);
    const hechos = campo(embed, 'Desbloqueados');
    assert.equal(hechos.name, 'Desbloqueados (3)');
    assert.equal(hechos.value.split('\n').length, 1, 'una sola línea con los tres');
    assert.ok(hechos.value.includes('**Charlatán** +200'), hechos.value);
  });

  test('los de una sola vez se agrupan en un renglón aparte', async () => {
    sembrar();
    const interaccion = interaccionFake();
    await logros.execute(interaccion);

    const sinMeta = campo(embedDe(interaccion), 'Sin progreso medible');
    assert.ok(sinMeta.value.includes('Búho nocturno') || sinMeta.value.includes('Madrugador'), sinMeta.value);
    assert.equal(sinMeta.value.split('\n').length, 1);
  });

  test('/estadisticas y /logros coinciden en cuál es el logro más cercano', async () => {
    sembrar();
    const ficha = interaccionFake();
    const lista = interaccionFake();
    await estadisticas.execute(ficha);
    await logros.execute(lista);

    const primero = campo(embedDe(ficha), 'Próximos logros').value.split('\n')[0];
    const masCerca = embedDe(lista).description.split('\n')[1];
    const nombre = primero.match(/\*\*(.+?)\*\*/)[1];
    assert.ok(masCerca.includes(nombre), `los dos tienen que apuntar al mismo logro: ${masCerca}`);
  });

  test('logrosConProgreso no lista metas ya cumplidas sin pagar', () => {
    // Nivel 5 y racha 5 ya cumplen nivel_5 y racha_3: no tienen que aparecer como pendientes.
    const pendientes = niveles.logrosConProgreso({ xp: 2000, mensajes: 200, nivel: 5, racha: 5, findes: 10, logros: [] });
    assert.ok(pendientes.length > 0, 'todavía le faltan logros');
    assert.ok(pendientes.every((p) => p.faltan > 0), 'una meta cumplida se paga, no se lista como pendiente');
    assert.ok(!pendientes.some((p) => p.logro.id === 'nivel_5'), 'nivel 5 ya cumple el nivel 5');
    assert.ok(!pendientes.some((p) => p.logro.id === 'racha_3'), 'racha 5 ya cumple la racha de 3');
    assert.ok(pendientes.some((p) => p.logro.id === 'nivel_10'), 'el nivel 10 sigue pendiente');
  });
});
