// Tests del cooldown por usuario de los comandos (utils/cooldowns.js).
//
// Cubren lo que el handler de index.js da por sentado: que el primer uso pase, que el
// segundo se bloquee con los segundos que faltan, que un intento bloqueado NO renueve el
// reloj (si no, spamear sería la forma de bloquear el comando para siempre) y que el
// registro de últimos usos no crezca sin control.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const cooldowns = require('../src/utils/cooldowns');
const { MAX_ENTRADAS, POR_DEFECTO_SEGUNDOS } = cooldowns;

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('cooldown de comandos', () => {
  test('el primer uso pasa y el segundo se bloquea con los segundos que faltan', () => {
    cooldowns.olvidar();

    assert.equal(cooldowns.esperar('meme', 'u1', 5), null, 'el primer uso tiene que pasar');
    const bloqueo = cooldowns.esperar('meme', 'u1', 5);
    assert.ok(bloqueo, 'el segundo intento tiene que quedar bloqueado');
    assert.ok(bloqueo.restante >= 1 && bloqueo.restante <= 5, `restante fuera de rango: ${bloqueo.restante}`);
  });

  test('sin declarar nada el comando usa el valor por defecto', () => {
    cooldowns.olvidar();

    assert.equal(POR_DEFECTO_SEGUNDOS, 2);
    assert.equal(cooldowns.esperar('ayuda', 'u1'), null);
    assert.ok(cooldowns.esperar('ayuda', 'u1'), 'el valor por defecto tiene que bloquear');
  });

  test('cooldown 0 desactiva el límite del comando', () => {
    cooldowns.olvidar();

    for (let i = 0; i < 5; i++) assert.equal(cooldowns.esperar('libre', 'u1', 0), null, `el intento ${i + 1} tiene que pasar`);
    assert.equal(cooldowns.tamano(), 0, 'un comando sin límite no ocupa lugar en el registro');
  });

  test('el cooldown es por usuario y por comando', () => {
    cooldowns.olvidar();

    assert.equal(cooldowns.esperar('top', 'u1', 9), null);
    assert.equal(cooldowns.esperar('top', 'u2', 9), null, 'otro usuario no comparte el cooldown');
    assert.equal(cooldowns.esperar('ip', 'u1', 9), null, 'otro comando no comparte el cooldown');
    assert.ok(cooldowns.esperar('top', 'u1', 9), 'el mismo par usuario+comando sí se bloquea');
  });

  test('spamear no renueva el reloj: la ventana corre desde el primer uso', async () => {
    cooldowns.olvidar();

    assert.equal(cooldowns.esperar('meme', 'u1', 0.1), null);
    for (let i = 0; i < 10; i++) assert.ok(cooldowns.esperar('meme', 'u1', 0.1), 'los intentos de más quedan bloqueados');

    await dormir(140);
    assert.equal(cooldowns.esperar('meme', 'u1', 0.1), null, 'pasada la ventana original tiene que volver a pasar');
  });

  test('el registro se poda y no crece sin control', () => {
    cooldowns.olvidar();

    for (let i = 0; i < MAX_ENTRADAS + 200; i++) cooldowns.esperar('masivo', `u-${i}`, 600);
    assert.ok(cooldowns.tamano() <= MAX_ENTRADAS, `el registro quedó en ${cooldowns.tamano()} entradas`);
  });

  test('el aviso nombra el comando y los segundos', () => {
    assert.equal(cooldowns.aviso('meme', 3), 'Esperá 3 s para volver a usar `/meme`.');
  });
});

describe('los comandos que salen a la red declaran su propio cooldown', () => {
  // Si alguien borra el `cooldown` de uno de estos, vuelve al valor por defecto (2 s) y
  // el límite deja de proteger las fuentes externas sin que nada falle a la vista.
  const ESPERADOS = { meme: 5, buscar: 5, servidores: 5, jugadores: 5, ip: 3, top: 3 };

  test('los que consultan internet o por UDP tienen un valor declarado', () => {
    for (const [nombre, valor] of Object.entries(ESPERADOS)) {
      const comando = require(`../src/commands/${nombre}`);
      assert.equal(comando.cooldown, valor, `/${nombre} debería declarar cooldown ${valor}`);
    }
  });
});
