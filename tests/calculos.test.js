// Cálculos exactos (utils/calculos.js). Este módulo existe para que las cuentas, los
// porcentajes, las conversiones y las fechas no dependan de la IA: tienen una sola
// respuesta correcta y se dan al instante, sin gastar cuota.
//
// Lo que se protege acá: que acierte SIEMPRE y que no conteste cualquier cosa. Un cálculo
// mal detectado (\"pasa por 4\" → 4) sería peor que no contestar, así que la mitad de los
// casos son frases que tienen que devolver null.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const calculos = require('../src/utils/calculos');

const texto = (m) => calculos.resolver(m)?.texto ?? null;

describe('números escritos a la argentina (y a la inglesa)', () => {
  test('miles con punto, decimales con coma y al revés', () => {
    assert.equal(calculos.aNumero('3.800'), 3800);
    assert.equal(calculos.aNumero('1.234.567'), 1234567);
    assert.equal(calculos.aNumero('1,5'), 1.5);
    assert.equal(calculos.aNumero('1,500'), 1500, 'tres dígitos después de la coma son miles');
    assert.equal(calculos.aNumero('2.5'), 2.5);
    assert.equal(calculos.aNumero('10.000,50'), 10000.5);
    assert.equal(calculos.aNumero('1,234.5'), 1234.5);
    assert.equal(calculos.aNumero('abc'), null);
  });
});

describe('cuentas', () => {
  test('aritmética con precedencia, paréntesis y potencias', () => {
    assert.equal(texto('12 * (3 + 4)'), '**12 × (3 + 4) = 84**');
    assert.equal(texto('cuánto es 2 + 3 * 4'), '**2 + 3 × 4 = 14**');
    assert.equal(texto('2^10'), '**2^10 = 1.024**');
    assert.equal(texto('cuánto es (2+3)*(4-1)'), '**(2+3) × (4-1) = 15**');
    assert.equal(texto('180 / 6'), '**180 ÷ 6 = 30**');
    assert.equal(texto('3 x 4'), '**3 × 4 = 12**', 'la x del celular es una multiplicación');
    assert.equal(texto('3 por 4'), '**3 × 4 = 12**');
    assert.equal(texto('1,5 * 4'), '**1,5 × 4 = 6**', 'los decimales entran en la cuenta');
  });

  test('raíces y funciones', () => {
    assert.equal(texto('raíz de 144'), '**√ 144 = 12**');
    assert.equal(texto('raiz cuadrada de 81'), '**√ 81 = 9**');
    assert.equal(texto('sqrt 16'), '**√ 16 = 4**');
  });

  test('lo que NO es una cuenta devuelve null (no se contesta cualquier cosa)', () => {
    for (const m of [
      'hola',
      'me gusta el 3 + 4',
      'el año 2024 fue bueno',
      'pasa por 4',
      'necesito 15 kg de harina',
      'que reglas tiene el server',
      'cuánto es 8/0',
      'a'.repeat(200),
    ]) {
      assert.equal(texto(m), null, `"${m}" no es una cuenta`);
    }
  });
});

describe('porcentajes', () => {
  test('el porcentaje de un total', () => {
    assert.equal(texto('cuánto es 18% de 3800'), '**18% de 3.800 = 684**');
    assert.equal(texto('el 30 por ciento de 1500'), '**30% de 1.500 = 450**');
  });

  test('aumentos y descuentos', () => {
    assert.equal(texto('3800 + 18%'), '**3.800 + 18% = 4.484**');
    assert.equal(texto('3800 - 18%'), '**3.800 − 18% = 3.116**');
    assert.equal(texto('3800 * 18%'), '**3.800 × 18% = 684**');
  });

  test('qué porcentaje representa una parte del total', () => {
    assert.equal(texto('qué porcentaje es 45 de 300'), '**45 de 300 es el 15%**');
    assert.equal(texto('cuánto por ciento representa 45 de 300'), '**45 de 300 es el 15%**');
  });
});

describe('conversión de unidades', () => {
  test('largo, masa, volumen y tiempo', () => {
    assert.equal(texto('120 km a millas'), '**120 km = 74,56 millas**');
    assert.equal(texto('180 cm en pulgadas'), '**180 cm = 70,87 pulgadas**');
    assert.equal(texto('70 kg a libras'), '**70 kg = 154,32 libras**');
    assert.equal(texto('2 litros a galones'), '**2 litros = 0,5283 galones**');
    assert.equal(texto('90 minutos a horas'), '**90 minutos = 1,5 horas**');
  });

  test('temperatura', () => {
    assert.equal(texto('30 °C a °F'), '**30 °C = 86 °F**');
    assert.equal(texto('100 °F a °C'), '**100 °F = 37,78 °C**');
    assert.equal(texto('212 fahrenheit a celsius'), '**212 °F = 100 °C**');
  });

  test('unidades de familias distintas no se convierten', () => {
    assert.equal(texto('5 km a kg'), null);
    assert.equal(texto('3 litros a grados'), null);
  });
});

describe('fechas', () => {
  test('días que faltan para una fecha (el año se deduce si ya pasó)', () => {
    const hoy = calculos.hoyArgentina();
    const resultado = texto('cuántos días faltan para el 25 de mayo');
    assert.match(resultado, /^Faltan \*\*[\d.]+ días\*\* para el 25 de mayo de \d{4} \(<t:\d+:D>\)\.$/);

    // Si el 25 de mayo ya pasó este año, la cuenta apunta al próximo.
    const anio = Number(/de (\d{4})/.exec(resultado)[1]);
    assert.ok(['Faltan', 'Falta', 'Es'].some((p) => resultado.startsWith(p)));
    assert.ok(anio === hoy.y || anio === hoy.y + 1);
    if (hoy.m > 5 || (hoy.m === 5 && hoy.d > 25)) assert.equal(anio, hoy.y + 1);
  });

  test('una fecha explícita se respeta', () => {
    assert.equal(texto('cuántos días faltan para el 1 de enero de 2027'), texto('cuantos dias faltan para el 1 de enero de 2027'));
    assert.match(texto('cuántos días faltan para el 1 de enero de 2027'), /para el 1 de enero de 2027/);
  });

  test('días transcurridos desde una fecha', () => {
    const resultado = texto('cuántos días pasaron desde el 1 de marzo de 2026');
    assert.match(resultado, /^Pasaron \*\*[\d.]+ días\*\* desde el 1 de marzo de 2026/);
  });

  test('un mes inventado o un día fuera de rango no se contestan', () => {
    assert.equal(texto('cuántos días faltan para el 45 de mayo'), null);
    assert.equal(texto('cuántos días faltan para el 3 de marziano'), null);
    assert.equal(texto('cuántos días faltan para hoy'), null);
  });
});
