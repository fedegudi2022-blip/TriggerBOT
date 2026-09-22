// Tests del sistema de canales de voz temporales (utils/voz.js).
// Fakes de Discord estilo objetos literales (como el resto de la suite); el
// registro de temporales usa el store real aislado en un directorio temporal.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-voz-'));

const voz = require('../src/utils/voz');
const store = require('../src/store');

const GUILD_ID = 'g-voz-1';
const DUENO_ID = '100000000000000001';
const OTRO_ID = '100000000000000002';

// ---------- Fakes de Discord ----------

function miembroFake(id, { bot = false, displayName = `user-${id}` } = {}) {
  const m = {
    id,
    user: { id, bot, tag: `${displayName}#0001` },
    displayName,
    roles: { cache: new Map() },
    permissions: { has: () => false },
  };
  m.voice = { channelId: null, disconnect: async () => {} };
  return m;
}

function canalVozFake(id, guild) {
  const canal = {
    id,
    guild,
    name: 'Canal de user',
    userLimit: 0,
    type: 2, // GuildVoice
    members: new Map(),
    enviados: [],
    borrado: false,
    overwriteEdits: [],
    overwritesEliminados: [],
    send: async (payload) => {
      canal.enviados.push(payload);
      return { id: 'msg' };
    },
    delete: async () => {
      canal.borrado = true;
      guild.channels.cache.delete(id);
    },
    permissionOverwrites: {
      edit: async (idOrRole, permisos) => {
        canal.overwriteEdits.push({ id: idOrRole, permisos });
      },
      delete: async (id) => {
        canal.overwritesEliminados.push(id);
      },
    },
    setName: async (nuevo) => {
      canal.name = nuevo;
    },
    setUserLimit: async (nuevo) => {
      canal.userLimit = nuevo;
    },
  };
  return canal;
}

function guildFake() {
  const mapa = new Map();
  const guild = {
    id: GUILD_ID,
    name: 'Server Voz',
    members: { cache: new Map() },
    channels: {
      // guild.channels.create(): crea y registra el canal (API real de discord.js).
      create: async (opciones) => {
        const id = `creado-${mapa.size + 1}`;
        const canal = canalVozFake(id, guild);
        canal.name = opciones.name;
        mapa.set(id, canal);
        return canal;
      },
      cache: {
        get: (id) => mapa.get(id),
        set: (id, v) => mapa.set(id, v),
        delete: (id) => mapa.delete(id),
        has: (id) => mapa.has(id),
      },
    },
    roles: { everyone: { id: 'role-everyone' } },
  };
  return guild;
}

function guild() {
  return guilds.get(GUILD_ID);
}
const guilds = new Map();

function clientFake() {
  return { guilds: { cache: guilds } };
}

// Estado de voz: crea o devuelve el canal con el miembro dentro.
function stateFake(guild, miembro, canalId) {
  const state = { guild, member: miembro, channelId: canalId ?? null, setChannel: async (c) => (miembro.voice.channelId = c.id) };
  if (canalId) {
    let canal = guild.channels.cache.get(canalId);
    if (!canal) {
      canal = canalVozFake(canalId, guild);
      guild.channels.cache.set(canalId, canal);
    }
    canal.members.set(miembro.id, miembro);
    miembro.voice.channelId = canalId;
  }
  return state;
}

// Cada test empieza con config limpia y un guild registrado.
function reset() {
  store.escribir(GUILD_ID, {});
  guilds.clear();
  guilds.set(GUILD_ID, guildFake());
  return guild();
}

describe('helpers puros', () => {
  test('nombreCanal reemplaza {usuario} y recorta a 90', () => {
    assert.equal(voz.nombreCanal('🔊 Canal de {usuario}', 'Federico'), '🔊 Canal de Federico');
    assert.equal(voz.nombreCanal(null, 'Ana').includes('Ana'), true, 'usa la plantilla por defecto');
    assert.ok(voz.nombreCanal('x'.repeat(200), 'u').length <= 90, 'recorta a 90');
    assert.equal(voz.nombreCanal('{usuario}', ''), 'usuario', 'sin nombre usa el placeholder');
  });

  test('limiteValido acepta 0-99 y rechaza lo demás', () => {
    assert.equal(voz.limiteValido(5), 5);
    assert.equal(voz.limiteValido('12'), 12);
    assert.equal(voz.limiteValido(0), 0, '0 = sin límite');
    assert.equal(voz.limiteValido(100), null);
    assert.equal(voz.limiteValido(-3), null);
    assert.equal(voz.limiteValido('hola'), null);
    assert.equal(voz.limiteValido(true), null);
  });

  test('nuevoDueno elige el primer humano, nunca un bot', () => {
    const canal = { members: new Map() };
    assert.equal(voz.nuevoDueno(canal), null, 'canal vacío');

    const bot = miembroFake('b1', { bot: true });
    const humano = miembroFake(OTRO_ID);
    canal.members.set('b1', bot);
    canal.members.set(OTRO_ID, humano);
    assert.equal(voz.nuevoDueno(canal).id, OTRO_ID);
  });
});

describe('registro de temporales (store real)', () => {
  test('registrar / consultar / olvidar', () => {
    reset();
    assert.equal(voz.esTemporal(GUILD_ID, 'c1'), false);
    voz.registrarTemporal(GUILD_ID, 'c1', DUENO_ID);
    assert.equal(voz.esTemporal(GUILD_ID, 'c1'), true);
    assert.equal(voz.duenoDe(GUILD_ID, 'c1'), DUENO_ID);
    assert.equal(voz.canalDeDueno(GUILD_ID, DUENO_ID), 'c1');
    assert.equal(voz.canalDeDueno(GUILD_ID, OTRO_ID), null);
    voz.olvidarTemporal(GUILD_ID, 'c1');
    assert.equal(voz.esTemporal(GUILD_ID, 'c1'), false);
    assert.equal(voz.duenoDe(GUILD_ID, 'c1'), null);
  });

  test('sobrevive un "reinicio" (relectura del store desde disco)', () => {
    reset();
    voz.registrarTemporal(GUILD_ID, 'c2', DUENO_ID);
    // El store persiste en disco: un nuevo proceso lo vería igual.
    const fila = store.leer(GUILD_ID);
    assert.equal(fila.voz.temporales.c2, DUENO_ID);
  });
});

describe('manejarCambio — ciclo de vida', () => {
  test('entrar al hub crea el canal temporal y mueve al usuario', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });
    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    // Canal hub (solo se referencia por ID en el estado).
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));
    const state = stateFake(g, dueno, 'hub-1');
    await voz.manejarCambio({ guild: g, channelId: null }, state);

    const canalId = voz.canalDeDueno(GUILD_ID, DUENO_ID);
    assert.ok(canalId, 'se registró un canal temporal para el dueño');
    const canal = g.channels.cache.get(canalId);
    assert.ok(canal, 'el canal existe');
    assert.match(canal.name, /Federico/, 'el nombre usa el displayName');
    assert.ok(canal.enviados.length >= 1, 'se publicó el panel de controles');
  });

  test('si ya tiene canal propio, lo manda al suyo (no crea otro)', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });
    const dueno = miembroFake(DUENO_ID);
    g.members.cache.set(DUENO_ID, dueno);
    const propio = canalVozFake('mio-1', g);
    g.channels.cache.set('mio-1', propio);
    voz.registrarTemporal(GUILD_ID, 'mio-1', DUENO_ID);

    const cantidadAntes = Object.keys(store.leer(GUILD_ID).voz?.temporales ?? {}).length;
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));

    assert.equal(Object.keys(store.leer(GUILD_ID).voz?.temporales ?? {}).length, cantidadAntes, 'no registra uno nuevo');
    assert.equal(dueno.voice.channelId, 'mio-1', 'lo movió a su canal, no creó uno nuevo');
  });

  test('canal vacío se borra solo (con gracia)', async () => {
    const g = reset();
    const dueno = miembroFake(DUENO_ID);
    const canal = canalVozFake('tmp-1', g);
    g.channels.cache.set('tmp-1', canal);
    voz.registrarTemporal(GUILD_ID, 'tmp-1', DUENO_ID);
    canal.members.set(DUENO_ID, dueno);

    // El dueño se va (Discord lo saca del cache del canal): canal queda vacío.
    canal.members.delete(DUENO_ID);
    await voz.manejarCambio({ guild: g, channelId: 'tmp-1' }, { guild: g, channelId: null, member: dueno });
    assert.equal(canal.borrado, false, 'aún no: está la gracia de 2 s');

    // Esperamos la gracia.
    await new Promise((r) => setTimeout(r, 2_600));
    assert.equal(canal.borrado, true, 'canal vacío borrado');
    assert.equal(voz.esTemporal(GUILD_ID, 'tmp-1'), false, 'y desregistrado');
  });

  test('el dueño se va pero queda gente: el dueño pasa al primer humano', async () => {
    const g = reset();
    const dueno = miembroFake(DUENO_ID, { displayName: 'Dueño' });
    const quedo = miembroFake(OTRO_ID, { displayName: 'Quedó' });
    const canal = canalVozFake('tmp-2', g);
    g.channels.cache.set('tmp-2', canal);
    voz.registrarTemporal(GUILD_ID, 'tmp-2', DUENO_ID);
    canal.members.set(OTRO_ID, quedo);

    await voz.manejarCambio({ guild: g, channelId: 'tmp-2' }, { guild: g, channelId: 'tmp-2', member: dueno });

    assert.equal(voz.duenoDe(GUILD_ID, 'tmp-2'), OTRO_ID, 'transferencia automática');
    assert.ok(canal.overwritesEliminados.includes(DUENO_ID), 'permisos del anterior removidos');
    assert.ok(canal.enviados.some((e) => JSON.stringify(e).includes('Quedó')), 'anuncia al nuevo dueño');
  });

  test('un bot no hereda el canal', async () => {
    const g = reset();
    const dueno = miembroFake(DUENO_ID);
    const bot = miembroFake('b-9', { bot: true });
    const canal = canalVozFake('tmp-3', g);
    g.channels.cache.set('tmp-3', canal);
    voz.registrarTemporal(GUILD_ID, 'tmp-3', DUENO_ID);
    canal.members.set('b-9', bot);

    await voz.manejarCambio({ guild: g, channelId: 'tmp-3' }, { guild: g, channelId: 'tmp-3', member: dueno });

    // Nadie humano: no transfiere (espera el borrado por vacío).
    assert.equal(voz.duenoDe(GUILD_ID, 'tmp-3'), DUENO_ID);
  });
});

describe('limpiarAlArrancar', () => {
  test('borra vacíos y conserva los ocupados', async () => {
    const g = reset();
    const dueno = miembroFake(DUENO_ID);
    const vacio = canalVozFake('vacio-1', g);
    const lleno = canalVozFake('lleno-1', g);
    g.channels.cache.set('vacio-1', vacio);
    g.channels.cache.set('lleno-1', lleno);
    lleno.members.set(DUENO_ID, dueno);
    voz.registrarTemporal(GUILD_ID, 'vacio-1', DUENO_ID);
    voz.registrarTemporal(GUILD_ID, 'lleno-1', DUENO_ID);

    await voz.limpiarAlArrancar(clientFake());

    assert.equal(vacio.borrado, true, 'vacío borrado al arrancar');
    assert.equal(lleno.borrado, false, 'ocupado se conserva');
    assert.equal(voz.esTemporal(GUILD_ID, 'lleno-1'), true, 'y sigue registrado');
  });

  test('desregistra canales que ya no existen', async () => {
    reset();
    voz.registrarTemporal(GUILD_ID, 'fantasma-1', DUENO_ID);
    await voz.limpiarAlArrancar(clientFake());
    assert.equal(voz.esTemporal(GUILD_ID, 'fantasma-1'), false);
  });
});
