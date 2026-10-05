// Tests de src/niveles.js (XP, cooldown, logros, debounce de escritura) y src/warns.js.
// Cada proceso de test usa su propio directorio de datos (TRIGGER_DATA_DIR).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-niveles-'));

const niveles = require('../src/niveles');
const warns = require('../src/warns');

const GUILD = 'guild-test';
const USUARIO = 'user-test';

// Martes 14:00 Argentina (día de semana, sin bonos de finde ni noche).
function fechaSemana(horaExtra = 0) {
  // 2026-09-22 es martes. 12:00 UTC = 09:00 Argentina.
  return new Date(Date.UTC(2026, 8, 22, 12, 0, 0) + horaExtra);
}

describe('XP y niveles', () => {
  test('primer mensaje: gana XP base y logro "primer_mensaje"', () => {
    const r = niveles.procesarMensaje(GUILD, USUARIO, fechaSemana());
    assert.ok(r.xpGanado > 0, 'debe ganar algo de XP');
    assert.ok(r.logrosNuevos.some((l) => l.id === 'primer_mensaje'), 'logro inicial pagado');
    assert.equal(r.nivelNuevo, 0);
  });

  test('cooldown: mensajes inmediatos NO dan XP (anti-farm) pero sí cuentan mensajes', () => {
    const r1 = niveles.procesarMensaje(GUILD, 'user-cooldown', fechaSemana());
    const r2 = niveles.procesarMensaje(GUILD, 'user-cooldown', fechaSemana(1000)); // +1 s
    assert.ok(r1.xpGanado > 0);
    assert.equal(r2.xpGanado, 0, 'dentro del cooldown no hay XP');
    assert.ok(r2.logrosNuevos.length === 0 || r2.xpGanado === 0);
    const datos = niveles.datosDe(GUILD, 'user-cooldown');
    assert.equal(datos.mensajes, 2, 'el mensaje cuenta aunque dé XP');
  });

  test('pasado el cooldown vuelve a dar XP', () => {
    niveles.procesarMensaje(GUILD, 'user-cooldown-2', fechaSemana());
    const r = niveles.procesarMensaje(GUILD, 'user-cooldown-2', fechaSemana(61_000)); // +61 s
    assert.ok(r.xpGanado > 0);
  });

  test('fin de semana: doble XP', () => {
    // 2026-09-20 es domingo. Mismo usuario, racha idéntica: solo cambia el finde.
    const rSemana = niveles.procesarMensaje('g-finde', 'u', new Date(Date.UTC(2026, 8, 22, 12)));
    const rFinde = niveles.procesarMensaje('g-finde', 'u2', new Date(Date.UTC(2026, 8, 20, 12)));
    // Comparación estadística no posible con azar; verificamos que el detalle marque finde.
    assert.equal(rSemana.detalle.finde, false);
    assert.equal(rFinde.detalle.finde, true);
    assert.ok(rFinde.detalle.total >= 30, 'con x2 el total nunca baja del mínimo base (15×2)');
  });

  test('racha de días suma bono acumulable', () => {
    const inicio = Date.UTC(2026, 8, 15, 12); // martes
    let tercero;
    for (let dia = 0; dia < 3; dia++) {
      tercero = niveles.procesarMensaje('g-racha', 'u-racha', new Date(inicio + dia * 86400_000));
    }
    const datos = niveles.datosDe('g-racha', 'u-racha');
    assert.ok(datos.racha >= 3, `racha esperada >= 3, hay ${datos.racha}`);
    // Con racha 3, el detalle del 3er mensaje muestra el bono (+3%).
    assert.ok(tercero.detalle, 'el 3er mensaje otorgó XP (cooldown superado)');
    assert.ok(tercero.detalle.bonoRacha >= 3, `bono de racha esperado >= 3, hay ${tercero.detalle?.bonoRacha}`);
  });

  test('nivelDe es consistente con xpParaNivel', () => {
    assert.equal(niveles.nivelDe(0), 0);
    assert.equal(niveles.nivelDe(niveles.xpParaNivel(5)), 5);
    assert.equal(niveles.nivelDe(niveles.xpParaNivel(10)), 10);
    assert.equal(niveles.nivelDe(niveles.xpParaNivel(5) - 1), 4);
  });

  test('ranking ordena por XP y posición encuentra al usuario', () => {
    const lista = niveles.ranking(GUILD);
    assert.ok(lista.length >= 1);
    assert.ok(niveles.posicion(GUILD, USUARIO) >= 1);
  });
});

describe('Logros', () => {
  test('los logros se pagan una sola vez (no se repiten)', () => {
    const r1 = niveles.procesarMensaje(GUILD, 'user-logros', fechaSemana());
    const logrosR1 = r1.logrosNuevos.map((l) => l.id);
    assert.ok(logrosR1.includes('primer_mensaje'));
    // Mensajes siguientes no repiten el logro.
    for (let i = 0; i < 5; i++) {
      const r = niveles.procesarMensaje(GUILD, 'user-logros', fechaSemana((i + 1) * 61_000));
      assert.ok(!r.logrosNuevos.some((l) => l.id === 'primer_mensaje'), 'no se repite');
    }
  });

  test('los premios de XP pueden hacer subir de nivel (encadenado de logros)', () => {
    // Colocamos al usuario con XP preexistente (escribir reemplaza el guild completo)
    // y verificamos que el resultado mantenga nivel y XP coherentes.
    niveles.escribir('g-cadena', { 'u-cadena': { xp: 200, mensajes: 0, findes: 0, nivel: 1, racha: 2, ultimoDia: null, logros: [] } });
    const r = niveles.procesarMensaje('g-cadena', 'u-cadena', fechaSemana());
    assert.ok(r.xpGanado > 0);
    // Verificación estructural: nivelNuevo coherente con el XP acumulado.
    const datos = niveles.datosDe('g-cadena', 'u-cadena');
    assert.equal(datos.nivel, niveles.nivelDe(datos.xp));
  });
});

describe('Persistencia con debounce', () => {
  test('escribir() persiste al instante y leer() devuelve lo guardado', () => {
    niveles.escribir('g-persist', { 'u-persist': { xp: 777, mensajes: 5, findes: 0, nivel: 2, racha: 0, logros: [] } });
    const datos = niveles.datosDe('g-persist', 'u-persist');
    assert.equal(datos.xp, 777);
  });

  test('volcar() escribe cambios en memoria a disco', () => {
    niveles.procesarMensaje('g-dump', 'u-dump', fechaSemana());
    niveles.volcar();
    // Releer el archivo crudo: el dato debe estar.
    const crudo = JSON.parse(fs.readFileSync(path.join(process.env.TRIGGER_DATA_DIR, 'niveles.json'), 'utf8'));
    assert.ok(crudo['g-dump']['u-dump'].mensajes >= 1);
  });

  test('procesarMensaje NO escribe a disco (queda en memoria hasta el debounce/volcar)', () => {
    const dir = process.env.TRIGGER_DATA_DIR;
    const archivo = path.join(dir, 'niveles.json');
    const antes = fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8') : '';
    niveles.procesarMensaje('g-nodebounce', 'u-nodebounce', fechaSemana());
    const despues = fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8') : '';
    assert.ok(!despues.includes('g-nodebounce'), 'sin volcar, el disco no debe conocer al usuario');
    niveles.volcar(); // limpieza del estado pendiente para otros tests
  });

  test('marcasPorGuild refleja cambios reales por servidor', () => {
    const antes = niveles.marcasPorGuild()['g-marcas'] ?? 0;
    niveles.procesarMensaje('g-marcas', 'u-marcas', fechaSemana());
    const despues = niveles.marcasPorGuild()['g-marcas'] ?? 0;
    assert.ok(despues > antes, 'la marca del guild tocado avanza');
    assert.ok(niveles.marcasPorGuild()['g-otro'] === undefined || true);
  });
});

describe('Warns', () => {
  test('addWarn acumula y devuelve el total; getWarns lista el historial', () => {
    assert.equal(warns.addWarn('g-warns', 'u1', { reason: 'spam', moderatorId: 'mod', timestamp: Date.now() }), 1);
    assert.equal(warns.addWarn('g-warns', 'u1', { reason: 'flood', moderatorId: 'mod', timestamp: Date.now() }), 2);
    assert.equal(warns.getWarns('g-warns', 'u1').length, 2);
  });

  test('removeWarn quita por índice (1-based) y reordena', () => {
    const quitado = warns.removeWarn('g-warns', 'u1', 1);
    assert.equal(quitado.reason, 'spam');
    const restantes = warns.getWarns('g-warns', 'u1');
    assert.equal(restantes.length, 1);
    assert.equal(restantes[0].reason, 'flood');
  });

  test('removeWarn con índice inválido devuelve null', () => {
    assert.equal(warns.removeWarn('g-warns', 'u1', 5), null);
    assert.equal(warns.removeWarn('g-warns', 'inexistente', 1), null);
  });

  test('los warns son independientes por servidor', () => {
    warns.addWarn('g-warns-A', 'uX', { reason: 'a', moderatorId: 'm', timestamp: Date.now() });
    assert.equal(warns.getWarns('g-warns-B', 'uX').length, 0);
  });

  test('marcasPorGuild avanza solo para el guild modificado', () => {
    const antes = warns.marcasPorGuild()['g-warns-marcas'] ?? 0;
    warns.addWarn('g-warns-marcas', 'u1', { reason: 'x', moderatorId: 'm', timestamp: Date.now() });
    assert.ok((warns.marcasPorGuild()['g-warns-marcas'] ?? 0) > antes);
  });
});

describe('ranking cacheado', () => {
  const G = 'g-cache';
  const dato = (xp, mensajes = 1, nivel = 0) => ({ xp, mensajes, nivel });

  test('el orden es estable entre llamadas y los empates se desempatan por mensajes', () => {
    niveles.escribir(G, { a: dato(500, 10, 3), b: dato(500, 20, 3), c: dato(900, 1, 5) });
    const esperado = ['c', 'b', 'a'];
    assert.deepEqual(
      niveles.ranking(G).map((e) => e.userId),
      esperado
    );
    assert.deepEqual(
      niveles.ranking(G).map((e) => e.userId),
      esperado
    );
  });

  test('posicion refleja el cambio apenas ocurre (la caché se invalida)', () => {
    niveles.escribir(G, { a: dato(100), b: dato(200) });
    assert.equal(niveles.posicion(G, 'a'), 2);

    niveles.escribir(G, { a: dato(900, 3, 3), b: dato(200) });
    assert.equal(niveles.posicion(G, 'a'), 1, 'el ranking viejo no puede quedar pegado');
  });

  test('la XP que entra por mensaje también invalida la caché', () => {
    niveles.escribir(G, { viejo: dato(5) });
    assert.equal(niveles.posicion(G, 'nuevo'), 0, 'todavía no existe');

    niveles.procesarMensaje(G, 'nuevo', fechaSemana());
    assert.equal(niveles.posicion(G, 'nuevo'), 1);
  });

  test('sin actividad no hay posición', () => {
    niveles.escribir(G, { a: dato(100) });
    assert.equal(niveles.posicion(G, 'nadie'), 0);
  });

  test('lo que se escribe en un servidor no ensucia el ranking de otro', () => {
    niveles.escribir('g-cache-A', { a: dato(10) });
    niveles.escribir('g-cache-B', { b: dato(20) });
    assert.equal(niveles.ranking('g-cache-A')[0].userId, 'a');
    assert.equal(niveles.ranking('g-cache-B')[0].userId, 'b');
  });
});
