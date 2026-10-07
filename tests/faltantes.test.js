// Registro de las preguntas que terminaron en negativa (utils/faltantes.js + /faltantes).
//
// Lo que se prueba es la promesa del sistema: que agrupe las repetidas aunque se escriban
// distinto, que ordene por lo que más se pregunta, que los números que muestra el comando
// sean EXACTAMENTE los que borra (si no, el staff borraría otro tema) y que el registro
// sobreviva al reinicio (está en data/faltantes.json, con respaldo en MariaDB).

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-faltantes-'));

const { MessageFlags } = require('discord.js');
const faltantes = require('../src/utils/faltantes');
const comando = require('../src/commands/faltantes');

const GUILD = 'g-faltantes';
const ARCHIVO = path.join(process.env.TRIGGER_DATA_DIR, 'faltantes.json');

beforeEach(() => {
  faltantes.limpiar(GUILD);
});

describe('registro de temas sin respuesta', () => {
  test('agrupa las repetidas aunque cambien tildes, signos y mayúsculas', () => {
    faltantes.registrar(GUILD, { pregunta: '¿Cuál es el horario del torneo?', usuario: 'Fede', canal: 'general', modo: 'comunidad' });
    faltantes.registrar(GUILD, { pregunta: 'cual es el horario del torneo', usuario: 'Sofi', canal: 'cs16', modo: 'comunidad' });

    const temas = faltantes.listar(GUILD);
    assert.equal(temas.length, 1, 'es el mismo tema');
    assert.equal(temas[0].veces, 2);
    assert.deepEqual(temas[0].autores, ['Fede', 'Sofi']);
    assert.equal(temas[0].canal, 'cs16', 'el contexto se actualiza con la última vez');
    assert.equal(temas[0].modo, 'comunidad');
    assert.ok(temas[0].ultima >= temas[0].primera);
  });

  test('el más preguntado va primero (y a igualdad, el más reciente)', () => {
    faltantes.registrar(GUILD, { pregunta: 'como pido el rol de streamer', cuando: 1000 });
    for (const cuando of [2000, 3000, 4000]) faltantes.registrar(GUILD, { pregunta: 'cuando es el proximo mix', cuando });
    faltantes.registrar(GUILD, { pregunta: 'hay servidor de cs2?', cuando: 5000 });

    const temas = faltantes.listar(GUILD);
    assert.deepEqual(
      temas.map((t) => t.pregunta),
      ['cuando es el proximo mix', 'hay servidor de cs2?', 'como pido el rol de streamer']
    );
    assert.equal(temas[0].veces, 3);
  });

  test('es una cola acotada: al llenarse se va el tema menos reciente', () => {
    for (let i = 0; i <= faltantes.MAX_TEMAS; i += 1) {
      faltantes.registrar(GUILD, { pregunta: `pregunta numero ${i}`, cuando: 1000 + i });
    }

    assert.equal(faltantes.total(GUILD), faltantes.MAX_TEMAS);
    const preguntas = faltantes.listar(GUILD, { limite: Infinity }).map((t) => t.pregunta);
    assert.ok(!preguntas.includes('pregunta numero 0'), 'el más viejo sin repeticiones se va');
    assert.ok(preguntas.includes(`pregunta numero ${faltantes.MAX_TEMAS}`), 'el nuevo entra');
  });

  test('borrar por número saca el tema que muestra la lista', () => {
    faltantes.registrar(GUILD, { pregunta: 'tema poco preguntado' });
    for (let i = 0; i < 3; i += 1) faltantes.registrar(GUILD, { pregunta: 'tema muy preguntado' });

    const antes = faltantes.listar(GUILD);
    const quitado = faltantes.olvidar(GUILD, 1);

    assert.equal(quitado.pregunta, antes[0].pregunta, 'el puesto 1 de la lista es el que se borra');
    assert.deepEqual(
      faltantes.listar(GUILD).map((t) => t.pregunta),
      ['tema poco preguntado']
    );
    assert.equal(faltantes.olvidar(GUILD, 9), null, 'un puesto que no existe no borra nada');
  });

  test('el registro se guarda en disco: sobrevive un reinicio', () => {
    faltantes.registrar(GUILD, { pregunta: 'como desbaneo a alguien', usuario: 'Fede', modo: 'comunidad' });

    const guardado = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
    assert.equal(guardado[GUILD][0].pregunta, 'como desbaneo a alguien');
    assert.equal(guardado[GUILD][0].veces, 1);
  });
});

// ---------- El comando como lo usa el staff ----------
function interaccionFake({ sub = 'ver', valores = {}, staff = true } = {}) {
  const capturadas = [];
  const miembro = {
    id: staff ? 'staff' : 'raso',
    permissions: { has: () => staff },
    roles: { cache: { has: () => false } },
  };

  return {
    capturadas,
    guild: { id: GUILD, ownerId: 'dueno' },
    guildId: GUILD,
    user: { id: miembro.id, username: 'staff' },
    member: miembro,
    options: {
      getSubcommand: () => sub,
      getInteger: (nombre) => valores[nombre] ?? null,
      getBoolean: (nombre) => valores[nombre] ?? null,
    },
    reply: async (payload) => {
      capturadas.push(payload);
      return payload;
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      capturadas.push(payload);
      return payload;
    },
  };
}

// Texto contenido en el embed que se le mostró al staff.
function textoDe(payload) {
  const embed = payload?.embeds?.[0];
  if (!embed) return '';
  const json = typeof embed.toJSON === 'function' ? embed.toJSON() : embed.data;
  return [json.title, json.description, json.footer?.text, ...(json.fields ?? []).map((f) => `${f.name}: ${f.value}`)]
    .filter(Boolean)
    .join('\n');
}

describe('el comando /faltantes', () => {
  test('sin permiso avisa en efímero y no toca la lista', async () => {
    faltantes.registrar(GUILD, { pregunta: 'tema que no se puede tocar' });
    const interaccion = interaccionFake({ staff: false, sub: 'limpiar', valores: { confirmar: true } });

    await comando.execute(interaccion);

    assert.ok(interaccion.capturadas[0].flags & MessageFlags.Ephemeral);
    assert.match(textoDe(interaccion.capturadas[0]), /solo para el staff/i);
    assert.equal(faltantes.total(GUILD), 1, 'la lista queda intacta');
  });

  test('ver muestra el tema con su puesto, las veces y quién lo preguntó', async () => {
    faltantes.registrar(GUILD, { pregunta: '¿Cómo pido el rol de streamer?', usuario: 'Fede', canal: 'general', modo: 'comunidad' });
    faltantes.registrar(GUILD, { pregunta: '¿Cómo pido el rol de streamer?', usuario: 'Sofi', canal: 'general', modo: 'comunidad' });

    const interaccion = interaccionFake({ sub: 'ver' });
    await comando.execute(interaccion);
    const texto = textoDe(interaccion.capturadas[0]);

    assert.match(texto, /\*\*1\.\*\* .*rol de streamer/);
    assert.match(texto, /2 veces/);
    assert.match(texto, /\*\*Fede\*\*, \*\*Sofi\*\*/);
    assert.match(texto, /comunidad · #general/);
    assert.match(texto, /docs\/conocimiento/, 'dice dónde se carga la respuesta');
    assert.ok(interaccion.capturadas[0].flags & MessageFlags.Ephemeral, 'la lista es de staff: no se filtra al canal');
  });

  test('la lista vacía explica que se llena sola', async () => {
    const interaccion = interaccionFake({ sub: 'ver' });
    await comando.execute(interaccion);

    assert.match(textoDe(interaccion.capturadas[0]), /No hay ninguno registrado/);
    assert.match(textoDe(interaccion.capturadas[0]), /se llena \*\*sola\*\*/);
  });

  test('borrar saca el tema del puesto indicado y limpiar vacía todo', async () => {
    faltantes.registrar(GUILD, { pregunta: 'uno', usuario: 'Fede' });
    faltantes.registrar(GUILD, { pregunta: 'dos', usuario: 'Fede' });
    faltantes.registrar(GUILD, { pregunta: 'dos', usuario: 'Sofi' });

    const borrar = interaccionFake({ sub: 'borrar', valores: { numero: 1 } });
    await comando.execute(borrar);
    assert.match(textoDe(borrar.capturadas[0]), /dos/, 'el primero de la lista es el más preguntado');
    assert.deepEqual(
      faltantes.listar(GUILD).map((t) => t.pregunta),
      ['uno']
    );

    const sinConfirmar = interaccionFake({ sub: 'limpiar', valores: { confirmar: false } });
    await comando.execute(sinConfirmar);
    assert.match(textoDe(sinConfirmar.capturadas[0]), /No vacié nada/);
    assert.equal(faltantes.total(GUILD), 1, 'sin confirmar no se pierde nada');

    const limpiar = interaccionFake({ sub: 'limpiar', valores: { confirmar: true } });
    await comando.execute(limpiar);
    assert.match(textoDe(limpiar.capturadas[0]), /Registro vaciado/);
    assert.equal(faltantes.total(GUILD), 0);
  });

  test('borrar un puesto inexistente avisa y no cambia la lista', async () => {
    faltantes.registrar(GUILD, { pregunta: 'uno' });

    const interaccion = interaccionFake({ sub: 'borrar', valores: { numero: 5 } });
    await comando.execute(interaccion);

    assert.match(textoDe(interaccion.capturadas[0]), /No hay ningún tema en el puesto \*\*5\*\*/);
    assert.equal(faltantes.total(GUILD), 1);
  });
});
