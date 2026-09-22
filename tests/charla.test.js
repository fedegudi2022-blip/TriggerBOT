// Tests de respuestas instantáneas (charla.js) y enrutado rápido (ia.js).
// Sin red: esMensajeSimple es puro y respuestaInstantanea no toca proveedores.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { respuestaInstantanea, normalizar } = require('../src/utils/charla');
const { esMensajeSimple, GROQ_RAPIDO } = require('../src/utils/ia');
const { DUENO_ID, WEB, REDES } = require('../src/comunidad');

describe('respuestaInstantanea — identidad y dueño', () => {
  test('quién te creó → menciona al dueño con su ID real', () => {
    for (const frase of ['quien te creo?', '@alguien te hizo', 'quien te programo', 'vos quien te desarrollo']) {
      const r = respuestaInstantanea(normalizar(frase));
      assert.ok(r, `debería responder a "${frase}"`);
      assert.ok(r.includes(`<@${DUENO_ID}>`), 'menciona al dueño con mención real de Discord');
      assert.match(r, /dueño/);
    }
  });

  test('quién es el dueño del bot → misma respuesta', () => {
    const r = respuestaInstantanea(normalizar('quien es el dueño del bot'));
    assert.ok(r);
    assert.ok(r.includes(`<@${DUENO_ID}>`));
  });

  test('identidad directa incluye al creador', () => {
    const r = respuestaInstantanea(normalizar('quien sos vos?'));
    assert.ok(r);
    assert.ok(r.includes(`<@${DUENO_ID}>`));
  });

  test('texto cualquiera no dispara respuesta (null → sigue a la IA)', () => {
    assert.equal(respuestaInstantanea(normalizar('como configuro el modlog')), null);
    assert.equal(respuestaInstantanea(normalizar('ban a fulano')), null);
    assert.equal(respuestaInstantanea(''), null);
  });
});

describe('respuestaInstantanea — links oficiales', () => {
  test('pregunta por la web → link real', () => {
    const r = respuestaInstantanea(normalizar('cual es la web oficial?'));
    assert.ok(r);
    assert.ok(r.includes(WEB));
  });

  test('pregunta por redes → todas las redes con sus links', () => {
    const r = respuestaInstantanea(normalizar('pasame las redes sociales'));
    assert.ok(r);
    for (const red of REDES) assert.ok(r.includes(red.url), `incluye ${red.nombre}`);
  });

  test('menciona whatsapp o instagram puntualmente → lista completa', () => {
    const r = respuestaInstantanea(normalizar('hay grupo de whatsapp?'));
    assert.ok(r && r.includes('whatsapp.com'), 'incluye el link de WhatsApp');
  });
});

describe('esMensajeSimple — enrutado rápido', () => {
  test('mensajes sociales cortos → modelo rápido', () => {
    for (const m of ['hola', 'todo bien?', 'como estas', 'gracias', 'jajaja', 'gg', 'que haces?', 'chau!']) {
      assert.ok(esMensajeSimple(m), `"${m}" debería ir al modelo chico`);
    }
  });

  test('preguntas complejas o largas → modelo grande', () => {
    for (const m of ['como configuro el anti spam del servidor', 'muteá a fulano por flodeo', 'hola, me explicas como funciona el sistema de niveles con bonus y logros?']) {
      assert.equal(esMensajeSimple(m), false, `"${m}" debería ir al 70b`);
    }
  });

  test('el modelo rápido es el 8b de Groq', () => {
    assert.equal(GROQ_RAPIDO, 'llama-3.1-8b-instant');
  });
});
