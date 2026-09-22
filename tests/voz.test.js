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
    setParentLlamadas: [],
    setParent: async (parentId, opciones) => {
      canal.parentId = parentId;
      canal.setParentLlamadas.push({ parentId, opciones });
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
        canal.parentId = opciones.parent; // como discord.js: refleja el parent dado
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
// Expone state.channel como el VoiceState real de discord.js.
function stateFake(guild, miembro, canalId) {
  let canal = null;
  if (canalId) {
    canal = guild.channels.cache.get(canalId);
    if (!canal) {
      canal = canalVozFake(canalId, guild);
      guild.channels.cache.set(canalId, canal);
    }
    canal.members.set(miembro.id, miembro);
    miembro.voice.channelId = canalId;
  }
  return {
    guild,
    member: miembro,
    channelId: canalId ?? null,
    channel: canal,
    setChannel: async (c) => (miembro.voice.channelId = c.id),
  };
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
    assert.equal(voz.nombreCanal('Canal de Voz de {usuario}', 'Federico'), 'Canal de Voz de Federico');
    assert.equal(voz.nombreCanal(null, 'Ana').includes('Ana'), true, 'usa la plantilla por defecto');
    assert.ok(voz.nombreCanal('x'.repeat(200), 'u').length <= 90, 'recorta a 90');
    assert.equal(voz.nombreCanal('{usuario}', ''), 'usuario', 'sin nombre usa el placeholder');
  });

  test('nombreConContador / nombreBaseDe son inversos', () => {
    assert.equal(voz.nombreConContador('Canal de Ana', 3, 0), 'Canal de Ana · 3');
    assert.equal(voz.nombreConContador('Canal de Ana', 3, 5), 'Canal de Ana · 3/5');
    assert.equal(voz.nombreBaseDe('Canal de Ana · 3/5'), 'Canal de Ana');
    assert.equal(voz.nombreBaseDe('Canal de Ana · 3'), 'Canal de Ana');
    assert.equal(voz.nombreBaseDe('Canal limpio'), 'Canal limpio', 'sin sufijo queda igual');
    assert.equal(voz.nombreConContador(voz.nombreBaseDe('X · 2'), 4, 0), 'X · 4');
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

  test('respeta la categoría configurada por el staff (no la del hub)', async () => {
    const g = reset();
    const categoriaVoz = { id: 'cat-voz', name: 'Voz', type: 4 }; // 4 = GuildCategory
    const otraCategoria = { id: 'cat-otra', name: 'Otra', type: 4 };
    g.channels.cache.set('cat-voz', categoriaVoz);
    g.channels.cache.set('cat-otra', otraCategoria);
    const hub = canalVozFake('hub-1', g);
    hub.parentId = 'cat-otra';
    g.channels.cache.set('hub-1', hub);
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1', categoriaId: 'cat-voz' } });

    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));

    const canalId = voz.canalDeDueno(GUILD_ID, DUENO_ID);
    assert.ok(canalId, 'se creó el canal temporal');
    const canal = g.channels.cache.get(canalId);
    assert.equal(canal.parentId, 'cat-voz', 'se creó en la categoría del staff, no en la del hub');
    assert.equal(voz.nombreBaseDe(canal.name), '🔊 Canal de Voz de Federico', 'nombre con formato por defecto (con emoji)');
  });

  test('los registros muertos (canales borrados a mano) no bloquean la creación', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });
    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));
    // 25 fantasmas llenarían el límite si no se limpiaran: la creación igual tiene que salir.
    for (let i = 0; i < 25; i++) voz.registrarTemporal(GUILD_ID, `muerto-${i}`, DUENO_ID);

    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));

    const canalId = voz.canalDeDueno(GUILD_ID, DUENO_ID);
    assert.ok(canalId, 'se creó el canal igual, pese a los fantasmas');
    assert.equal(Object.keys(voz.temporalesDe(GUILD_ID)).length, 1, 'solo queda el canal nuevo registrado');
  });

  test('si la categoría configurada falla, reintentará con la del hub', async () => {
    const g = reset();
    const categoriaRota = { id: 'cat-rota', name: 'Rota', type: 4 };
    g.channels.cache.set('cat-rota', categoriaRota);
    const hub = canalVozFake('hub-1', g);
    hub.parentId = 'cat-hub';
    g.channels.cache.set('hub-1', hub);
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1', categoriaId: 'cat-rota' } });

    const createOriginal = g.channels.create;
    g.channels.create = async (opciones) => {
      if (opciones.parent === 'cat-rota') throw new Error('Missing Permissions');
      return createOriginal(opciones);
    };

    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));

    const canalId = voz.canalDeDueno(GUILD_ID, DUENO_ID);
    const canal = g.channels.cache.get(canalId);
    assert.ok(canal, 'igual se creó el canal');
    assert.equal(canal.parentId, 'cat-hub', 'usó la categoría del hub como fallback');
  });

  test('si no puede crear en ningún lado, avisa en el chat del hub y no registra nada', async () => {
    const g = reset();
    const hub = canalVozFake('hub-1', g);
    g.channels.cache.set('hub-1', hub);
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });

    g.channels.create = async () => {
      throw new Error('Missing Permissions');
    };

    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));

    assert.equal(voz.canalDeDueno(GUILD_ID, DUENO_ID), null, 'nada registrado');
    assert.ok(hub.enviados.some((e) => JSON.stringify(e).includes('No se pudo crear tu canal')), 'aviso en el chat del hub');
    assert.ok(hub.enviados.some((e) => JSON.stringify(e).includes('Missing Permissions')), 'incluye el motivo real');
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

describe('moverTemporalesACategoria', () => {
  test('mueve los canales registrados y conserva sus permisos (lockPermissions: false)', async () => {
    const g = reset();
    const c1 = canalVozFake('t-1', g);
    const c2 = canalVozFake('t-2', g);
    g.channels.cache.set('t-1', c1);
    g.channels.cache.set('t-2', c2);
    voz.registrarTemporal(GUILD_ID, 't-1', DUENO_ID);
    voz.registrarTemporal(GUILD_ID, 't-2', OTRO_ID);

    const movidos = await voz.moverTemporalesACategoria(g, 'cat-nueva');

    assert.equal(movidos.length, 2, 'movió los dos canales registrados');
    assert.equal(c1.parentId, 'cat-nueva');
    assert.equal(c2.parentId, 'cat-nueva');
    assert.equal(c1.setParentLlamadas[0].opciones.lockPermissions, false, 'no sincroniza permisos con la categoría');
  });

  test('ignora los canales que ya no existen', async () => {
    reset();
    voz.registrarTemporal(GUILD_ID, 'fantasma', DUENO_ID);
    const movidos = await voz.moverTemporalesACategoria(guilds.get(GUILD_ID), 'cat-nueva');
    assert.equal(movidos.length, 0);
  });
});

describe('registro de eventos de voz (canal de logs)', () => {
  test('creación, transferencia y borrado quedan registrados', async () => {
    const g = reset();
    const logs = canalVozFake('logs-1', g);
    g.channels.cache.set('logs-1', logs);
    store.escribir(GUILD_ID, { logs: 'logs-1', voz: { hubId: 'hub-1', eventos: 'todo' } });

    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    const otro = miembroFake(OTRO_ID, { displayName: 'Nacho' });
    g.members.cache.set(DUENO_ID, dueno);
    g.members.cache.set(OTRO_ID, otro);
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));

    // 1) Entró al hub → evento de creación.
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));
    await new Promise((r) => setImmediate(r)); // logEvent manda sin await
    assert.ok(logs.enviados.some((e) => JSON.stringify(e).includes('creado')), 'evento de creación');

    // 2) El dueño se va y queda otro → evento de transferencia.
    const canalId = voz.canalDeDueno(GUILD_ID, DUENO_ID);
    stateFake(g, otro, canalId);
    const canal = g.channels.cache.get(canalId);
    canal.members.delete(DUENO_ID);
    await voz.manejarCambio({ guild: g, channelId: canalId }, { guild: g, channelId: canalId, member: dueno });
    await new Promise((r) => setImmediate(r));
    assert.ok(logs.enviados.some((e) => JSON.stringify(e).includes('transferido')), 'evento de transferencia');

    // 3) Queda vacío → borrado automático con evento.
    canal.members.delete(OTRO_ID);
    await voz.manejarCambio({ guild: g, channelId: canalId }, { guild: g, channelId: null, member: otro });
    await new Promise((r) => setTimeout(r, 2_600));
    assert.equal(canal.borrado, true, 'canal borrado');
    assert.ok(logs.enviados.some((e) => JSON.stringify(e).includes('borrado')), 'evento de borrado');
  });
});

describe('contador de usuarios en el nombre', () => {
  test('el canal nace con contador en 1 y sube cuando entra gente', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });
    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));

    const canalId = voz.canalDeDueno(GUILD_ID, DUENO_ID);
    const canal = g.channels.cache.get(canalId);
    assert.equal(canal.name, '🔊 Canal de Voz de Federico · 1', 'nace con el contador en 1 (el dueño está por aterrizar)');

    // El dueño aterriza en su canal y entra otro: el contador sube a 2.
    stateFake(g, dueno, canalId);
    const otro = miembroFake(OTRO_ID, { displayName: 'Nacho' });
    stateFake(g, otro, canalId);
    await voz.manejarCambio({ guild: g, channelId: 'hub-1' }, { guild: g, channelId: canalId, member: otro });
    await new Promise((r) => setImmediate(r));
    assert.equal(canal.name, '🔊 Canal de Voz de Federico · 2', 'se actualiza al entrar otro');
  });

  test('con /voz contador apagado, los nombres quedan sin cantidad', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1', contador: false } });
    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));

    const canalId = voz.canalDeDueno(GUILD_ID, DUENO_ID);
    const canal = g.channels.cache.get(canalId);
    assert.equal(canal.name, '🔊 Canal de Voz de Federico', 'sin sufijo');

    stateFake(g, dueno, canalId);
    const otro = miembroFake(OTRO_ID);
    stateFake(g, otro, canalId);
    await voz.manejarCambio({ guild: g, channelId: 'hub-1' }, { guild: g, channelId: canalId, member: otro });
    await new Promise((r) => setImmediate(r));
    assert.equal(canal.name, '🔊 Canal de Voz de Federico', 'sigue sin sufijo');
  });

  test('respeta el límite de Discord: 2 renombres por 10 min, el resto espera la ventana', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });
    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));
    const canalId = voz.canalDeDueno(GUILD_ID, DUENO_ID);
    const canal = g.channels.cache.get(canalId);
    stateFake(g, dueno, canalId);

    // Entra gente rápido: solo los 2 primeros renombres son inmediatos (límite de Discord).
    for (let n = 2; n <= 4; n++) {
      const alguien = miembroFake(`u-${n}`, { displayName: `u${n}` });
      stateFake(g, alguien, canalId);
      await voz.manejarCambio({ guild: g, channelId: canalId }, { guild: g, channelId: canalId, member: alguien });
      await new Promise((r) => setImmediate(r));
    }
    // Nació en ·1, usó los 2 renombres del cupo (·2, ·3) y el ·4 queda esperando la ventana.
    assert.equal(canal.name, '🔊 Canal de Voz de Federico · 3', 'el excedente se encola, no dispara 429');
  });
});

describe('nivel de registros (/voz logs)', () => {
  test('por defecto solo errores: las rutinas no ensucian el canal de logs', async () => {
    const g = reset();
    const logs = canalVozFake('logs-1', g);
    g.channels.cache.set('logs-1', logs);
    store.escribir(GUILD_ID, { logs: 'logs-1', voz: { hubId: 'hub-1' } }); // sin eventos: default "errores"

    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));
    await new Promise((r) => setImmediate(r));

    assert.ok(voz.canalDeDueno(GUILD_ID, DUENO_ID), 'el canal se creó igual');
    assert.equal(logs.enviados.length, 0, 'creación silenciada por defecto');
    assert.equal(voz.nivelEventos(GUILD_ID), 'errores');
  });

  test('los fallos se registran siempre, aunque el nivel sea "nada"', async () => {
    const g = reset();
    const logs = canalVozFake('logs-1', g);
    const hub = canalVozFake('hub-1', g);
    g.channels.cache.set('logs-1', logs);
    g.channels.cache.set('hub-1', hub);
    store.escribir(GUILD_ID, { logs: 'logs-1', voz: { hubId: 'hub-1', eventos: 'nada' } });
    g.channels.create = async () => {
      throw new Error('Missing Permissions');
    };

    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));
    await new Promise((r) => setImmediate(r));

    assert.ok(logs.enviados.some((e) => JSON.stringify(e).includes('Error creando canal temporal')), 'el error igual queda registrado');
    assert.equal(logs.enviados.length, 1, 'y solo el error');
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
