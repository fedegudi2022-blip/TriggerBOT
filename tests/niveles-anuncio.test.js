// Tests del anuncio de progreso (src/events/messageCreate.js) y de los roles por nivel.
// Lo que se cuida acá es que el anuncio sea UN mensaje de texto (no embeds) con la XP
// ganada, los logros agrupados, el rol otorgado y el cambio de rango.
// Cada proceso de test usa su propio directorio de datos (TRIGGER_DATA_DIR).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-anuncio-'));

const { textoProgreso, anunciarProgreso } = require('../src/events/messageCreate');
const { asignarRolesNivel, definirRol } = require('../src/utils/rolesNivel');
const niveles = require('../src/niveles');
const { setGuildConfig } = require('../src/store');

const GUILD = 'guild-anuncio';
const USUARIO = 'user-anuncio';
const CANAL = 'canal-anuncio';

// XP acumulada exacta para que al nivel 12 falten 1.544 (el número se lee en el assert).
const XP_NIVEL_12 = niveles.xpParaNivel(13) - 1544;

// Fake mínimo de mensaje: solo lo que el anuncio usa. `author.toString()` imita la
// mención de discord.js, que es lo que el bot interpola para pingear al usuario.
function mensajeFake({ canal = null } = {}) {
  return {
    guild: { id: GUILD, channels: { cache: new Map(canal ? [[CANAL, canal]] : []) } },
    author: { id: USUARIO, username: 'fede', toString: () => `<@${USUARIO}>` },
  };
}

// Canal fake que guarda lo que se le manda.
function canalFake() {
  const canal = { enviados: [], send: async (payload) => canal.enviados.push(payload) };
  return canal;
}

function sembrar(datos) {
  niveles.escribir(GUILD, { [USUARIO]: { xp: 0, mensajes: 0, findes: 0, nivel: 0, racha: 0, logros: [], ...datos } });
}

function configurarCanal() {
  setGuildConfig(GUILD, (c) => {
    c.canalNiveles = CANAL;
  });
}

function logroDe(id) {
  return niveles.LOGROS.find((l) => l.id === id);
}

// Progreso típico de una subida de nivel (11 → 12, ambos rango Experto).
function progresoSubida(extra = {}) {
  return {
    xpGanado: 22,
    detalle: { base: 22, bonoRacha: 0, finde: false, noche: false, total: 22 },
    premioTotal: 0,
    subio: true,
    nivelAnterior: 11,
    nivelNuevo: 12,
    logrosNuevos: [],
    totalMensajes: 121,
    ...extra,
  };
}

describe('anuncio de progreso: un solo mensaje de texto', () => {
  test('la subida va en un único mensaje sin embeds, con la XP ganada y lo que falta', async () => {
    configurarCanal();
    sembrar({ xp: XP_NIVEL_12, nivel: 12, mensajes: 121, racha: 3, logros: ['primer_mensaje'] });
    const canal = canalFake();

    await anunciarProgreso(mensajeFake({ canal }), progresoSubida());

    assert.equal(canal.enviados.length, 1, 'una subida = un mensaje');
    assert.equal(canal.enviados[0].embeds, undefined, 'no lleva embed: es texto plano');
    const texto = canal.enviados[0].content;
    assert.equal(typeof texto, 'string');
    assert.ok(texto.includes(`<@${USUARIO}> subió al nivel **12** (Experto)`), texto);
    assert.ok(texto.includes('+22 XP'), `falta la XP ganada: ${texto}`);
    assert.ok(texto.includes('faltan **1.544**'), texto);
    assert.ok(texto.includes('(~78 mensajes)'), `falta la traducción a mensajes: ${texto}`);
  });

  test('una subida con logros nuevos sigue siendo UN mensaje, con todos los logros juntos', async () => {
    configurarCanal();
    sembrar({ xp: XP_NIVEL_12, nivel: 12, logros: [] });
    const canal = canalFake();

    await anunciarProgreso(
      mensajeFake({ canal }),
      progresoSubida({ xpGanado: 622, premioTotal: 600, logrosNuevos: [logroDe('charlatan'), logroDe('semana')] })
    );

    assert.equal(canal.enviados.length, 1, 'antes eran 3 mensajes (nivel + un embed por logro)');
    const texto = canal.enviados[0].content;
    assert.ok(texto.includes('+622 XP'), texto);
    assert.ok(texto.includes('Logros: **Charlatán** +200 XP · **Semana activa** +400 XP'), texto);
  });

  test('el bonus de la jugada se explica en la misma línea', async () => {
    configurarCanal();
    sembrar({ xp: XP_NIVEL_12, nivel: 12, logros: [] });
    const canal = canalFake();

    await anunciarProgreso(
      mensajeFake({ canal }),
      progresoSubida({ xpGanado: 48, detalle: { base: 22, bonoRacha: 7, finde: true, noche: false, total: 24 } })
    );

    const texto = canal.enviados[0].content;
    assert.ok(texto.includes('+48 XP (x2 finde · +7% racha)'), texto);
  });

  test('salto de nivel: se nombra de dónde a dónde, no solo el nivel final', async () => {
    configurarCanal();
    sembrar({ xp: XP_NIVEL_12, nivel: 12, logros: [] });
    const canal = canalFake();

    // Un premio de logros puede saltar varios niveles de una: el mensaje tiene que decirlo.
    await anunciarProgreso(mensajeFake({ canal }), progresoSubida({ nivelAnterior: 9, nivelNuevo: 12 }));

    const texto = canal.enviados[0].content;
    assert.ok(texto.includes('subió del nivel **9** al **12**'), texto);
    assert.ok(texto.includes('Nuevo rango: **Activo → Experto**'), texto);
  });

  test('el aviso de rango aparece solo cuando cruza el umbral', async () => {
    configurarCanal();
    sembrar({ xp: XP_NIVEL_12, nivel: 12, logros: [] });
    const canal = canalFake();

    await anunciarProgreso(mensajeFake({ canal }), progresoSubida({ nivelAnterior: 11, nivelNuevo: 12 }));
    assert.ok(!canal.enviados[0].content.includes('Nuevo rango'), '11 → 12 sigue siendo Experto');

    await anunciarProgreso(mensajeFake({ canal }), progresoSubida({ nivelAnterior: 4, nivelNuevo: 5 }));
    assert.ok(canal.enviados[1].content.includes('Nuevo rango: **Novato → Activo**'), canal.enviados[1].content);
  });

  test('el rol otorgado se nombra, y no se promete si no hubo ninguno', async () => {
    configurarCanal();
    sembrar({ xp: XP_NIVEL_12, nivel: 12, logros: [] });
    const canal = canalFake();

    await anunciarProgreso(mensajeFake({ canal }), progresoSubida());
    assert.ok(!canal.enviados[0].content.includes('Rol:'), 'sin roles no se inventa la línea');

    await anunciarProgreso(mensajeFake({ canal }), progresoSubida(), [
      { id: 'r1', nombre: 'Veterano' },
      { id: 'r2', nombre: 'Leyenda' },
    ]);
    assert.ok(canal.enviados[1].content.includes('Rol: **Veterano**, **Leyenda**'), canal.enviados[1].content);
  });

  test('solo logros (sin subir de nivel): no habla de niveles y muestra el total', async () => {
    configurarCanal();
    sembrar({ xp: 500, nivel: 2, logros: ['primer_mensaje'] });
    const canal = canalFake();

    await anunciarProgreso(
      mensajeFake({ canal }),
      progresoSubida({ subio: false, nivelAnterior: 2, nivelNuevo: 2, xpGanado: 200, detalle: null, logrosNuevos: [logroDe('charlatan')] })
    );

    assert.equal(canal.enviados.length, 1);
    const texto = canal.enviados[0].content;
    assert.ok(texto.includes('desbloqueó un logro nuevo'), texto);
    assert.ok(!texto.includes('subió'), texto);
    assert.ok(texto.includes('**500 XP** en total · 1/16 logros'), texto);
    assert.ok(texto.includes('Logros: **Charlatán** +200 XP'), texto);
    assert.ok(!texto.includes('Nuevo rango'), texto);
  });

  test('sin nada que contar o sin canal configurado no manda nada', async () => {
    const canal = canalFake();
    configurarCanal();

    await anunciarProgreso(mensajeFake({ canal }), progresoSubida({ subio: false, logrosNuevos: [] }));
    assert.equal(canal.enviados.length, 0, 'sin subida ni logros no hay anuncio');

    setGuildConfig(GUILD, (c) => {
      delete c.canalNiveles;
    });
    await anunciarProgreso(mensajeFake({ canal }), progresoSubida());
    assert.equal(canal.enviados.length, 0, 'sin canal de niveles no se manda');
  });

  test('textoProgreso se puede armar sin Discord de por medio', () => {
    sembrar({ xp: XP_NIVEL_12, nivel: 12, logros: [] });
    const texto = textoProgreso(mensajeFake(), progresoSubida());
    assert.equal(texto.split('\n').length, 2, 'sin logros, rol ni rango el mensaje queda en dos líneas');
  });
});

describe('roles por nivel: devuelve solo lo que otorgó', () => {
  // Miembro fake con la jerarquía y los permisos que mira asignarRolesNivel.
  function miembroFake({ permisos = true, posicion = 3, yaTiene = [] } = {}) {
    const agregados = [];
    const roles = new Map([
      ['rol-5', { id: 'rol-5', name: 'Activo', managed: false, position: 2 }],
      ['rol-10', { id: 'rol-10', name: 'Experto', managed: false, position: 2 }],
    ]);
    return {
      agregados,
      guild: {
        id: GUILD,
        roles: { cache: roles },
        members: { me: { permissions: { has: () => permisos }, roles: { highest: { position: posicion } } } },
      },
      roles: {
        cache: { has: (id) => yaTiene.includes(id) },
        add: async (ids) => agregados.push(...ids),
      },
    };
  }

  test('devuelve los roles nuevos con su nombre', async () => {
    definirRol(GUILD, 5, 'rol-5');
    definirRol(GUILD, 10, 'rol-10');
    const miembro = miembroFake();

    const otorgados = await asignarRolesNivel(miembro, 10);

    assert.deepEqual(otorgados, [
      { id: 'rol-10', nombre: 'Experto' },
      { id: 'rol-5', nombre: 'Activo' },
    ]);
    assert.deepEqual(miembro.agregados, ['rol-10', 'rol-5']);
  });

  test('no repite roles que ya tenía', async () => {
    definirRol(GUILD, 5, 'rol-5');
    definirRol(GUILD, 10, 'rol-10');
    const miembro = miembroFake({ yaTiene: ['rol-10'] });

    const otorgados = await asignarRolesNivel(miembro, 10);

    assert.deepEqual(otorgados, [{ id: 'rol-5', nombre: 'Activo' }]);
    assert.deepEqual(miembro.agregados, ['rol-5'], 'el que ya tenía no se vuelve a agregar');
  });

  test('sin permiso de gestionar roles no devuelve nada (no promete lo que no pasó)', async () => {
    definirRol(GUILD, 5, 'rol-5');
    const miembro = miembroFake({ permisos: false });

    const otorgados = await asignarRolesNivel(miembro, 5);

    assert.deepEqual(otorgados, []);
    assert.deepEqual(miembro.agregados, []);
  });

  test('si Discord rechaza la asignación, el rol no se anuncia', async () => {
    definirRol(GUILD, 5, 'rol-5');
    const miembro = miembroFake();
    miembro.roles.add = async () => {
      throw new Error('Missing Permissions');
    };

    const otorgados = await asignarRolesNivel(miembro, 5);
    assert.deepEqual(otorgados, []);
  });
});
