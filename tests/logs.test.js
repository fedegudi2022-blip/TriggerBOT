// Tests de /logs buscar (y de los filtros nuevos de casos.listar).
//
// El comando se corre con una interacción fake: acá importa que filtre bien, que pagine,
// que no se caiga con un filtro inválido y que la puerta de staff siga cerrada.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-logs-'));

const casos = require('../src/casos');
const logsCmd = require('../src/commands/logs');

after(() => fs.rmSync(process.env.TRIGGER_DATA_DIR, { recursive: true, force: true }));

const GUILD = 'g-logs';
const DIA = 86400_000;

// Historial de prueba: 4 casos con acciones, moderadores y fechas distintas.
const FILAS = [
  { numero: 1, action: 'Advertencia (warn)', targetId: 'u-1', moderatorId: 'm-1', reason: 'spam', timestamp: Date.now() - 20 * DIA },
  { numero: 2, action: 'Baneo (ban)', targetId: 'u-2', moderatorId: 'm-1', reason: 'raid', timestamp: Date.now() - 6 * DIA },
  { numero: 3, action: 'Baneo temporal (tempban)', targetId: 'u-1', moderatorId: 'm-2', reason: 'insultos', timestamp: Date.now() - 2 * DIA },
  { numero: 4, action: 'Silencio (timeout)', targetId: 'u-3', moderatorId: 'm-2', reason: null, timestamp: Date.now() - 3600_000 },
];

function sembrar() {
  casos.escribir(GUILD, []);
  for (const fila of FILAS) casos.registrar(GUILD, fila);
}

function interaccionFake({ opciones = {}, staff = true } = {}) {
  const llamadas = { replies: [], responds: [] };
  const guild = { id: GUILD, name: 'Server' };
  const ix = {
    guild,
    guildId: GUILD,
    user: { id: 'staff-1', username: 'staff-1' },
    // `nivelStaff` primero mira los permisos nativos y después los roles de /config.
    member: { permissions: { has: () => staff }, roles: { cache: { has: () => false } } },
    options: {
      getString: (n) => opciones[n] ?? null,
      getInteger: (n) => opciones[n] ?? null,
      getUser: (n) => opciones[n] ?? null,
      getFocused: () => opciones.focused ?? '',
    },
    async reply(payload) {
      llamadas.replies.push(payload);
      return payload;
    },
    async respond(opcionesRespondidas) {
      llamadas.responds.push(opcionesRespondidas);
    },
  };
  return { ix, llamadas };
}

const embedDe = (llamadas) => llamadas.replies[0].embeds[0];
const campos = (embed) => embed.data.fields ?? [];
const numeros = (embed) => campos(embed).map((f) => f.name.match(/^#(\d+)/)?.[1] ?? f.name);
const efimero = (payload) => Boolean(payload?.flags && payload.flags & MessageFlags.Ephemeral);

// La API fake de usuarios: sólo hace falta que `toString()` mencione al usuario.
const usuario = (id) => ({ id, username: id, toString: () => `<@${id}>` });

describe('casos.listar con filtros', () => {
  test('filtra por usuario, moderador y acción', () => {
    sembrar();
    assert.equal(casos.listar(GUILD, { usuarioId: 'u-1' }).length, 2);
    assert.equal(casos.listar(GUILD, { moderadorId: 'm-1' }).length, 2);
    assert.equal(casos.listar(GUILD, { accion: 'Baneo (ban)' }).length, 1);
    // Los dos filtros se combinan (AND): solo el warn #1 lo aplicó m-1 sobre u-1.
    assert.deepEqual(
      casos.listar(GUILD, { moderadorId: 'm-1', usuarioId: 'u-1' }).map((c) => c.numero),
      [1]
    );
  });

  test('la acción se busca por texto, sin distinguir mayúsculas ni tildes', () => {
    sembrar();
    // "baneo" trae el baneo, el temporal y sus variantes rechazadas.
    assert.equal(casos.listar(GUILD, { accion: 'baneo' }).length, 2);
    assert.equal(casos.listar(GUILD, { accion: 'SILENCIO' }).length, 1);
  });

  test('filtra por antigüedad', () => {
    sembrar();
    const desde = Date.now() - 7 * DIA;
    assert.deepEqual(
      casos.listar(GUILD, { desde }).map((c) => c.numero),
      [4, 3, 2]
    );
    assert.equal(casos.listar(GUILD, { desde, hasta: Date.now() - 3 * DIA }).length, 1);
  });

  test('acciones() devuelve las acciones distintas, ordenadas', () => {
    sembrar();
    assert.deepEqual(casos.acciones(GUILD), ['Advertencia (warn)', 'Baneo (ban)', 'Baneo temporal (tempban)', 'Silencio (timeout)']);
  });
});

describe('/logs buscar', () => {
  test('sin filtros muestra los últimos casos, del más nuevo al más viejo', async () => {
    sembrar();
    const { ix, llamadas } = interaccionFake();
    await logsCmd.execute(ix);

    const embed = embedDe(llamadas);
    assert.deepEqual(numeros(embed), ['4', '3', '2', '1']);
    assert.match(embed.data.description, /\*\*4\*\* caso\(s\)/);
    assert.match(embed.data.fields[0].value, /aplicado por <@m-2>/);
    assert.match(embed.data.fields[2].value, /> raid/);
  });

  test('combina los filtros y lo dice en el embed', async () => {
    sembrar();
    const { ix, llamadas } = interaccionFake({ opciones: { accion: 'baneo', desde: '7d', usuario: usuario('u-2') } });
    await logsCmd.execute(ix);

    const embed = embedDe(llamadas);
    assert.deepEqual(numeros(embed), ['2']);
    assert.match(embed.data.description, /acción «baneo»/);
    assert.match(embed.data.description, /últimos 7d/);
  });

  test('un filtro que no matchea nada lo dice, en vez de mostrar el historial completo', async () => {
    sembrar();
    const { ix, llamadas } = interaccionFake({ opciones: { accion: 'no existe' } });
    await logsCmd.execute(ix);

    const embed = embedDe(llamadas);
    assert.equal(numeros(embed)[0], 'Sin resultados');
    assert.match(embed.data.description, /\*\*0\*\* caso\(s\)/);
  });

  test('pagina los resultados de a 10', async () => {
    casos.escribir(GUILD, []);
    for (let n = 1; n <= 12; n++) {
      casos.registrar(GUILD, { numero: n, action: 'Advertencia (warn)', targetId: `u-${n}`, moderatorId: 'm-1', timestamp: Date.now() - n });
    }

    const primera = interaccionFake({ opciones: { pagina: 1 } });
    await logsCmd.execute(primera.ix);
    assert.equal(campos(embedDe(primera.llamadas)).length, 10);
    assert.match(embedDe(primera.llamadas).data.footer.text, /página 1\/2/);

    const segunda = interaccionFake({ opciones: { pagina: 2 } });
    await logsCmd.execute(segunda.ix);
    assert.equal(campos(embedDe(segunda.llamadas)).length, 2);

    // Una página fuera de rango no rompe: cae en la última que existe.
    const lejana = interaccionFake({ opciones: { pagina: 99 } });
    await logsCmd.execute(lejana.ix);
    assert.match(embedDe(lejana.llamadas).data.footer.text, /página 2\/2/);
    assert.equal(campos(embedDe(lejana.llamadas)).length, 2);
  });

  test('una antigüedad inválida avisa en vez de buscar cualquier cosa', async () => {
    sembrar();
    const { ix, llamadas } = interaccionFake({ opciones: { desde: 'la semana pasada' } });
    await logsCmd.execute(ix);

    assert.ok(efimero(llamadas.replies[0]), 'el error tiene que ser efímero');
    assert.match(llamadas.replies[0].embeds[0].data.description, /No pude interpretar/);
    assert.equal(llamadas.replies[0].embeds[0].data.fields, undefined, 'no debe mostrar resultados');
  });

  test('un miembro común no entra al registro', async () => {
    sembrar();
    const { ix, llamadas } = interaccionFake({ staff: false });
    await logsCmd.execute(ix);

    assert.equal(llamadas.replies.length, 1);
    assert.ok(efimero(llamadas.replies[0]));
    assert.equal(llamadas.replies[0].embeds[0].data.title, 'Solo staff');
  });

  test('el autocompletado ofrece las acciones registradas y filtra por lo escrito', async () => {
    sembrar();
    const vacio = interaccionFake({ opciones: { focused: '' } });
    await logsCmd.autocomplete(vacio.ix);
    assert.equal(vacio.llamadas.responds[0].length, 4);

    const conTexto = interaccionFake({ opciones: { focused: 'temp' } });
    await logsCmd.autocomplete(conTexto.ix);
    assert.deepEqual(conTexto.llamadas.responds[0], [{ name: 'Baneo temporal (tempban)', value: 'Baneo temporal (tempban)' }]);
  });

  test('el autocompletado no explota en un servidor sin casos', async () => {
    // El comando lee el guildId de la interacción: se apunta a un servidor vacío.
    casos.escribir('g-sin-casos', []);
    const fake = interaccionFake({ opciones: { focused: '' } });
    fake.ix.guildId = 'g-sin-casos';
    await logsCmd.autocomplete(fake.ix);
    assert.deepEqual(fake.llamadas.responds[0], []);
  });
});
