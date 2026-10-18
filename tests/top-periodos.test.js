// Tests de /top por período: la semana y el mes se calculan con `xpPorDia` y no
// modifican el ranking acumulado (ni los botones viejos `top:page:<n>`).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-top-periodos-'));

const top = require('../src/commands/top');
const niveles = require('../src/niveles');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

const GUILD = 'guild-periodos';
const FECHA = new Date('2026-10-14T12:00:00Z'); // miércoles 14/10 en Argentina

function fechaClave(valor) {
  return niveles.fechaArgClave(valor);
}

function datosBase(extra) {
  niveles.escribir(GUILD, {
    u1: { xp: 10_000, nivel: niveles.nivelDe(10_000), mensajes: 500, findes: 0, racha: 0, logros: [], ...extra.u1 },
    u2: { xp: 700, nivel: niveles.nivelDe(700), mensajes: 30, findes: 0, racha: 0, logros: [], ...extra.u2 },
    u3: { xp: 900, nivel: niveles.nivelDe(900), mensajes: 40, findes: 0, racha: 0, logros: [], ...extra.u3 },
  });
}

function interaccionFake({ periodo = null, boton = null } = {}) {
  const capturado = { reply: null, update: null };
  return {
    capturado,
    isButton: () => boton !== null,
    customId: boton ?? '',
    guild: { id: GUILD, iconURL: () => null },
    user: { id: 'u2' },
    options: { getInteger: () => 1, getString: () => periodo },
    reply: async (p) => (capturado.reply = p),
    update: async (p) => (capturado.update = p),
  };
}

describe('ranking por período', () => {
  test('la semana ordena por XP de la semana y no por el acumulado', () => {
    datosBase({
      // u1 es el veterano, pero esta semana no sumó nada.
      u1: { xpPorDia: { [niveles.fechaArgClave(new Date('2026-09-20T12:00:00Z'))]: 10_000 } },
      // u2 sumó 400 esta semana (dos días).
      u2: { xpPorDia: { [niveles.inicioSemanaClave(FECHA)]: 300, [fechaClave(FECHA)]: 100 } },
      // u3 sumó 800 el mes pasado.
      u3: { xpPorDia: { [niveles.fechaArgClave(new Date('2026-09-28T12:00:00Z'))]: 800 } },
    });

    const semana = niveles.rankingPeriodo(GUILD, 'semana', 10, FECHA);
    assert.deepEqual(semana.map((e) => [e.userId, e.xp]), [['u2', 400]]);
    assert.equal(niveles.ranking(GUILD, 10)[0].userId, 'u1', 'el acumulado sigue igual');
  });

  test('el mes suma todos los días del mes calendario', () => {
    datosBase({
      u1: { xpPorDia: { [niveles.inicioMesClave(FECHA)]: 100 } },
      u2: { xpPorDia: { [niveles.inicioMesClave(FECHA)]: 50, [fechaClave(FECHA)]: 350 } },
      u3: { xpPorDia: { [niveles.fechaArgClave(new Date('2026-09-28T12:00:00Z'))]: 800 } },
    });

    const mes = niveles.rankingPeriodo(GUILD, 'mes', 10, FECHA);
    assert.deepEqual(mes.map((e) => [e.userId, e.xp]), [['u2', 400], ['u1', 100]]);
  });

  test('sin período devuelve el acumulado de siempre', () => {
    datosBase({ u1: {}, u2: {}, u3: {} });
    const ranking = niveles.rankingPeriodo(GUILD, 'acumulado', 10, FECHA);
    assert.equal(ranking[0].userId, 'u1');
    assert.equal(ranking[0].xp, 10_000);
  });

  test('xpEnPeriodo devuelve la XP del usuario en ese rango', () => {
    datosBase({
      u2: { xpPorDia: { [niveles.inicioSemanaClave(FECHA)]: 300, [fechaClave(FECHA)]: 100 } },
    });
    assert.equal(niveles.xpEnPeriodo(GUILD, 'u2', 'semana', FECHA), 400);
    assert.equal(niveles.xpEnPeriodo(GUILD, 'u2', 'acumulado', FECHA), 700);
  });
});

describe('/top por período en Discord', () => {
  function sembrarConXPReciente(cantidad) {
    const datos = {};
    for (let i = 1; i <= cantidad; i += 1) {
      datos[`u${i}`] = {
        xp: i * 100,
        nivel: niveles.nivelDe(i * 100),
        mensajes: 10,
        findes: 0,
        racha: 0,
        logros: [],
        xpPorDia: { [niveles.fechaArgClave(new Date())]: i },
      };
    }
    niveles.escribir(GUILD, datos);
  }

  test('el período elegido cambia el título y el orden', async () => {
    sembrarConXPReciente(3);
    const ix = interaccionFake({ periodo: 'mes' });
    await top.execute(ix);

    const embed = ix.capturado.reply.embeds[0].data;
    assert.match(embed.title, /^Ranking mensual — página 1\/1$/);
    assert.match(embed.footer.text, /ranking este mes/);
    const filas = embed.description.split('\n').filter((l) => l.startsWith('**#'));
    assert.ok(filas[0].includes('<@u3>'), 'u3 sumó más este mes');
  });

  test('los botones conservan el período de la página', async () => {
    sembrarConXPReciente(12);
    const ix = interaccionFake({ periodo: 'semana' });
    await top.execute(ix);

    const [, siguiente] = ix.capturado.reply.components[0].components.map((b) => b.data);
    assert.equal(siguiente.custom_id, 'top:page:semana:2');

    const segunda = interaccionFake({ boton: 'top:page:semana:2' });
    await top.ejecutar(segunda);
    const [anterior] = segunda.capturado.update.components[0].components.map((b) => b.data);
    assert.equal(anterior.custom_id, 'top:page:semana:1');
    assert.match(segunda.capturado.update.embeds[0].data.title, /^Ranking semanal — página 2\/2$/);
  });

  test('los botones viejos (sin período) siguen abriendo el acumulado', async () => {
    sembrarConXPReciente(3);
    const ix = interaccionFake({ boton: 'top:page:1' });
    await top.ejecutar(ix);
    assert.match(ix.capturado.update.embeds[0].data.title, /^Ranking de actividad — página 1\/1$/);
  });
});
