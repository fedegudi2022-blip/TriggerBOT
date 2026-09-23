// Tests del sistema de canales de voz temporales (utils/voz.js).
// Fakes de Discord estilo objetos literales (como el resto de la suite); el
// registro de temporales usa el store real aislado en un directorio temporal.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-voz-'));

const voz = require('../src/utils/voz');
const store = require('../src/store');
const comandoVoz = require('../src/commands/voz');

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
  m.disconnects = [];
  m.voice = { channelId: null, disconnect: async (motivo) => m.disconnects.push(motivo) };
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
    bitrateEdits: [],
    regionEdits: [],
    send: async (payload) => {
      canal.enviados.push(payload);
      return { id: 'msg' };
    },
    delete: async () => {
      canal.borrado = true;
      guild.channels.cache.delete(id);
    },
    permissionOverwrites: {
      cache: new Map(), // para probar permitidosDe/estaBloqueado: [[id, { id, allow, deny }]]
      edit: async (idOrRole, permisos) => {
        canal.overwriteEdits.push({ id: idOrRole, permisos });
      },
      delete: async (idBorrado) => {
        canal.overwritesEliminados.push(idBorrado);
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
    setBitrate: async (nuevo) => {
      canal.bitrate = nuevo;
      canal.bitrateEdits.push(nuevo);
    },
    setRTCRegion: async (nuevo) => {
      canal.rtcRegion = nuevo;
      canal.regionEdits.push(nuevo);
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
        values: () => mapa.values(),
      },
    },
    roles: { everyone: { id: 'role-everyone' } },
  };
  return guild;
}

// Acceso al guild de prueba. Se llama guildActual (y no guild) para no chocar con
// los parámetros `guild` de los fakes: un shadowing acá no rompe nada, pero ensucia
// el lint y esconde errores de verdad.
function guildActual() {
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
  return guildActual();
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

  test('por defecto, si la categoría configurada falla NO crea fuera de ella (avisa y registra)', async () => {
    const g = reset();
    const categoriaRota = { id: 'cat-rota', name: 'Rota', type: 4 };
    g.channels.cache.set('cat-rota', categoriaRota);
    const hub = canalVozFake('hub-1', g);
    hub.parentId = 'cat-hub';
    g.channels.cache.set('hub-1', hub);
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1', categoriaId: 'cat-rota' } });

    const createOriginal = g.channels.create;
    const intentos = [];
    g.channels.create = async (opciones) => {
      intentos.push(opciones.parent);
      if (opciones.parent === 'cat-rota') throw new Error('Missing Permissions');
      return createOriginal(opciones);
    };

    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));

    assert.deepEqual(intentos, ['cat-rota'], 'solo intentó la categoría configurada: sin fallback encubierto');
    assert.equal(voz.canalDeDueno(GUILD_ID, DUENO_ID), null, 'no se registró ningún canal');
    assert.ok(hub.enviados.some((e) => JSON.stringify(e).includes('No se pudo crear tu canal')), 'aviso en el chat del hub');
  });

  test('con fallbackCategoriaHub activado, sí reintentará con la categoría del hub', async () => {
    const g = reset();
    const categoriaRota = { id: 'cat-rota', name: 'Rota', type: 4 };
    g.channels.cache.set('cat-rota', categoriaRota);
    const hub = canalVozFake('hub-1', g);
    hub.parentId = 'cat-hub';
    g.channels.cache.set('hub-1', hub);
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1', categoriaId: 'cat-rota', fallbackCategoriaHub: true } });

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
    assert.equal(canal.parentId, 'cat-hub', 'usó la categoría del hub como fallback explícito');
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

    const { movidos, fallidos } = await voz.moverTemporalesACategoria(g, 'cat-nueva');

    assert.equal(movidos.length, 2, 'movió los dos canales registrados');
    assert.equal(fallidos.length, 0, 'ningún canal falló');
    assert.equal(c1.parentId, 'cat-nueva');
    assert.equal(c2.parentId, 'cat-nueva');
    assert.equal(c1.setParentLlamadas[0].opciones.lockPermissions, false, 'no sincroniza permisos con la categoría');
  });

  test('ignora los canales que ya no existen', async () => {
    reset();
    voz.registrarTemporal(GUILD_ID, 'fantasma', DUENO_ID);
    const { movidos, fallidos } = await voz.moverTemporalesACategoria(guilds.get(GUILD_ID), 'cat-nueva');
    assert.equal(movidos.length, 0);
    assert.equal(fallidos.length, 0);
  });

  test('un canal que Discord rechaza mover queda en fallidos (con su motivo), no en movidos', async () => {
    const g = reset();
    const ok = canalVozFake('t-ok', g);
    const roto = canalVozFake('t-roto', g);
    g.channels.cache.set('t-ok', ok);
    g.channels.cache.set('t-roto', roto);
    roto.setParent = async () => {
      throw new Error('Missing Permissions');
    };
    voz.registrarTemporal(GUILD_ID, 't-ok', DUENO_ID);
    voz.registrarTemporal(GUILD_ID, 't-roto', OTRO_ID);

    const { movidos, fallidos } = await voz.moverTemporalesACategoria(g, 'cat-nueva');

    assert.equal(movidos.length, 1, 'solo el que realmente se movió');
    assert.equal(movidos[0].id, 't-ok');
    assert.equal(fallidos.length, 1);
    assert.equal(fallidos[0].canalId, 't-roto');
    assert.match(fallidos[0].motivo, /Missing Permissions/);
    assert.equal(roto.parentId, undefined, 'el canal rechazado no se movió');
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

// ---------- Fakes de interacciones del panel (botones, selects y modales) ----------

function interactionPanelFake({ canal, userId, customId, values = [], staff = false, fields = null }) {
  const member = miembroFake(userId, { displayName: `user-${userId}` });
  if (staff) member.permissions = { has: (p) => p === PermissionFlagsBits.ManageChannels };
  member.voice.channelId = canal.members.has(userId) ? canal.id : null;
  return {
    customId,
    values,
    user: { id: userId, tag: `user-${userId}#0001` },
    member,
    guild: canal.guild,
    channel: canal,
    client: { user: { id: 'bot-voz' } },
    fields,
    replies: [],
    followUps: [],
    updates: [],
    deferred: false,
    async reply(p) {
      this.replies.push(p);
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async followUp(p) {
      this.followUps.push(p);
    },
    async update(p) {
      this.updates.push(p);
    },
    showModal: async () => {},
  };
}

// Canal temporal registrado con su dueño (dentro del canal y en el cache del guild).
function canalTemporalConDueno(g, canalId, duenoId) {
  const dueno = miembroFake(duenoId, { displayName: `dueño-${duenoId}` });
  const canal = canalVozFake(canalId, g);
  g.channels.cache.set(canalId, canal);
  canal.members.set(duenoId, dueno);
  g.members.cache.set(duenoId, dueno);
  voz.registrarTemporal(GUILD_ID, canalId, duenoId);
  return { canal, dueno };
}

describe('nuevoDueno por antigüedad de entrada', () => {
  test('gana el humano que entró primero (sello inyectable), no el orden del cache', () => {
    const canal = { guild: { id: GUILD_ID }, members: new Map() };
    const tardio = miembroFake('u-tardio', { displayName: 'Tardío' });
    const temprano = miembroFake('u-temprano', { displayName: 'Temprano' });
    const bot = miembroFake('u-bot', { bot: true });
    canal.members.set('u-tardio', tardio); // el cache lo pone primero...
    canal.members.set('u-temprano', temprano);
    canal.members.set('u-bot', bot);
    const sellos = { 'u-tardio': 5_000, 'u-temprano': 1_000, 'u-bot': 500 };

    const elegido = voz.nuevoDueno(canal, { obtenerSello: (_guildId, id) => sellos[id] ?? null });

    assert.equal(elegido.id, 'u-temprano', 'el que lleva más tiempo adentro');
  });

  test('los bots quedan excluidos aunque "entraran" primero', () => {
    const canal = { guild: { id: GUILD_ID }, members: new Map() };
    canal.members.set('u-bot', miembroFake('u-bot', { bot: true }));
    canal.members.set('u-humano', miembroFake('u-humano'));
    const sellos = { 'u-bot': 100, 'u-humano': 9_000 };
    assert.equal(voz.nuevoDueno(canal, { obtenerSello: (_g, id) => sellos[id] ?? null }).id, 'u-humano');
  });

  test('un miembro sin sello (reinicio) no le gana a quien sí tiene', () => {
    const canal = { guild: { id: GUILD_ID }, members: new Map() };
    canal.members.set('u-sindato', miembroFake('u-sindato')); // primero en el cache
    canal.members.set('u-condato', miembroFake('u-condato'));
    const elegido = voz.nuevoDueno(canal, { obtenerSello: (_g, id) => (id === 'u-condato' ? 42 : null) });
    assert.equal(elegido.id, 'u-condato');
  });

  test('si no queda ningún humano, no hay transferencia', () => {
    const canal = { guild: { id: GUILD_ID }, members: new Map() };
    canal.members.set('u-bot', miembroFake('u-bot', { bot: true }));
    assert.equal(voz.nuevoDueno(canal, { obtenerSello: () => 1 }), null);
  });
});

describe('creaciones concurrentes (bloqueo por guildId:userId)', () => {
  test('dos voiceStateUpdate casi simultáneos crean UN solo canal temporal', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });
    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));

    await Promise.all([
      voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1')),
      voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1')),
    ]);

    const creados = [...g.channels.cache.values()].filter((c) => voz.esTemporal(GUILD_ID, c.id));
    assert.equal(creados.length, 1, 'el segundo evento esperó y reusó el canal del primero');
    assert.equal(voz.canalDeDueno(GUILD_ID, DUENO_ID), creados[0].id);
    assert.equal(dueno.voice.channelId, creados[0].id, 'y quedó metido en él');
  });

  test('si la creación falla, el bloqueo se libera igual (finally) y se puede reintentar', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });
    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));

    const createOriginal = g.channels.create;
    g.channels.create = async () => {
      throw new Error('Missing Permissions');
    };
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));
    assert.equal(voz.canalDeDueno(GUILD_ID, DUENO_ID), null);

    // Discord vuelve a la normalidad: el reintento NO queda bloqueado para siempre.
    g.channels.create = createOriginal;
    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));
    assert.ok(voz.canalDeDueno(GUILD_ID, DUENO_ID), 'el segundo intento pudo crear');
  });
});

describe('revalidación de permisos en manejarSelect', () => {
  test('el dueño que dejó de serlo mientras el menú estaba abierto ya no puede expulsar', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-sel', DUENO_ID);
    const victima = miembroFake('u-victima', { displayName: 'Víctima' });
    canal.members.set('u-victima', victima);
    g.members.cache.set('u-victima', victima);

    // Mientras el menú estaba abierto, el canal pasó a otro dueño.
    voz.registrarTemporal(GUILD_ID, 'tmp-sel', OTRO_ID);

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:kick', values: ['u-victima'] });
    await voz.manejarSelect(i);

    assert.equal(victima.disconnects.length, 0, 'no lo expulsó');
    assert.match(i.followUps[0].content, /cambiaron/);
  });

  test('un usuario normal (ni dueño ni staff) no puede usar el selector', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-sel2', DUENO_ID);
    const victima = miembroFake('u-victima', { displayName: 'Víctima' });
    canal.members.set('u-victima', victima);
    g.members.cache.set('u-victima', victima);

    const i = interactionPanelFake({ canal, userId: 'u-intruso', customId: 'voz:sel:kick', values: ['u-victima'] });
    await voz.manejarSelect(i);

    assert.equal(victima.disconnects.length, 0);
    assert.match(i.followUps[0].content, /cambiaron|Solo el dueño/);
  });

  test('el staff autorizado puede expulsar aunque no sea dueño', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-sel3', DUENO_ID);
    const victima = miembroFake('u-victima', { displayName: 'Víctima' });
    canal.members.set('u-victima', victima);
    g.members.cache.set('u-victima', victima);

    const i = interactionPanelFake({ canal, userId: 'u-staff', customId: 'voz:sel:kick', values: ['u-victima'], staff: true });
    await voz.manejarSelect(i);

    assert.equal(victima.disconnects.length, 1, 'el staff pudo expulsar');
    assert.match(i.followUps[0].content, /Expulsaste/);
  });

  test('si el canal ya no es un temporal activo, el selector no hace nada', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-sel4', DUENO_ID);
    voz.olvidarTemporal(GUILD_ID, 'tmp-sel4'); // desregistrado entre medio

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:kick', values: [DUENO_ID] });
    await voz.manejarSelect(i);

    assert.match(i.updates[0].content, /ya no existe/);
  });
});

describe('operaciones rechazadas por Discord (errores reales, no éxitos fingidos)', () => {
  test('cerrar con permisos rechazados: avisa y NO dice "canal cerrado"', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-lock-fail', DUENO_ID);
    canal.permissionOverwrites.edit = async () => {
      throw new Error('Missing Permissions');
    };
    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:lock' });
    await voz.manejarComponente(i);

    assert.match(i.followUps[0].content, /rechazó el cierre/);
    assert.match(i.followUps[0].content, /Missing Permissions/);
    assert.equal(store.leer(GUILD_ID).voz?.bloqueos?.['tmp-lock-fail'], undefined, 'no quedó registrado como bloqueado');
  });

  test('renombrar rechazado: el modal avisa y el nombre no cambia', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-ren-fail', DUENO_ID);
    canal.setName = async () => {
      throw new Error('Missing Permissions');
    };
    const i = interactionPanelFake({
      canal,
      userId: DUENO_ID,
      customId: 'voz:modal:nombre',
      fields: { getTextInputValue: () => 'Nombre Nuevo' },
    });
    await voz.manejarModal(i);

    assert.match(i.replies[0].content, /rechazó el renombre/);
    assert.notEqual(canal.name, 'Nombre Nuevo');
  });

  test('cambiar límite rechazado: avisa y el límite no cambia', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-lim-fail', DUENO_ID);
    canal.userLimit = 3;
    canal.setUserLimit = async () => {
      throw new Error('Missing Permissions');
    };
    const i = interactionPanelFake({
      canal,
      userId: DUENO_ID,
      customId: 'voz:modal:limite',
      fields: { getTextInputValue: () => '10' },
    });
    await voz.manejarModal(i);

    assert.match(i.replies[0].content, /rechazó el cambio de límite/);
    assert.equal(canal.userLimit, 3);
  });

  test('expulsión rechazada: avisa en vez de decir "expulsado"', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-kick-fail', DUENO_ID);
    const victima = miembroFake('u-victima', { displayName: 'Víctima' });
    canal.members.set('u-victima', victima);
    g.members.cache.set('u-victima', victima);
    victima.voice.disconnect = async () => {
      throw new Error('Missing Permissions');
    };

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:kick', values: ['u-victima'] });
    await voz.manejarSelect(i);

    assert.match(i.followUps[0].content, /rechazó la expulsión/);
  });

  test('bloquear usuario con overwrites rechazados: avisa y no lo expulsa', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-bloq-fail', DUENO_ID);
    const molesto = miembroFake('u-molesto', { displayName: 'Molesto' });
    canal.members.set('u-molesto', molesto);
    g.members.cache.set('u-molesto', molesto);
    canal.permissionOverwrites.edit = async () => {
      throw new Error('Missing Permissions');
    };

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:bloquear', values: ['u-molesto'] });
    await voz.manejarSelect(i);

    assert.match(i.followUps[0].content, /rechazó el cambio de permisos/);
    assert.equal(molesto.disconnects.length, 0, 'no lo expulsó si el overwrite falló');
  });

  test('borrar rechazado: el canal sigue registrado (no queda huérfano)', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-del-fail', DUENO_ID);
    canal.delete = async () => {
      throw new Error('Missing Permissions');
    };
    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:borrar' });
    await voz.manejarComponente(i);

    assert.match(i.followUps[0].content, /rechazó el borrado/);
    assert.equal(voz.esTemporal(GUILD_ID, 'tmp-del-fail'), true);
  });

  test('las operaciones exitosas conservan su mensaje de éxito', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-ok', DUENO_ID);
    const victima = miembroFake('u-victima', { displayName: 'Víctima' });
    canal.members.set('u-victima', victima);
    g.members.cache.set('u-victima', victima);

    const iLock = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:lock' });
    await voz.manejarComponente(iLock);
    assert.match(iLock.followUps[0].content, /Canal \*\*cerrado\*\*/);

    const iKick = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:kick', values: ['u-victima'] });
    await voz.manejarSelect(iKick);
    assert.match(iKick.followUps[0].content, /Expulsaste/);
  });

  test('el cierre manual queda persistido como indefinido (0) y abrir lo limpia', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-lock-ok', DUENO_ID);

    const iLock = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:lock' });
    await voz.manejarComponente(iLock);
    assert.equal(store.leer(GUILD_ID).voz.bloqueos['tmp-lock-ok'], 0, 'indefinido y sobrevive reinicios');

    const iUnlock = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:unlock' });
    await voz.manejarComponente(iUnlock);
    assert.match(iUnlock.followUps[0].content, /\*\*abierto\*\*/);
    assert.equal(store.leer(GUILD_ID).voz.bloqueos['tmp-lock-ok'], undefined);
    assert.ok(canal.overwriteEdits.some((e) => e.permisos[PermissionFlagsBits.Connect] === null), 'Connect restaurado');
  });
});

describe('permisos de chat del dueño', () => {
  test('al crear el canal, el dueño recibe voz + ViewChannel/ReadMessageHistory/SendMessages', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });
    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    g.members.cache.set(DUENO_ID, dueno);
    g.channels.cache.set('hub-1', canalVozFake('hub-1', g));

    const creaciones = [];
    const createOriginal = g.channels.create;
    g.channels.create = async (opciones) => {
      creaciones.push(opciones);
      return createOriginal(opciones);
    };

    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));

    assert.ok(voz.canalDeDueno(GUILD_ID, DUENO_ID), 'el canal se creó');
    const permisos = creaciones[0].permissionOverwrites.find((o) => o.id === DUENO_ID).allow;
    for (const p of [...voz.PERMISOS_DUENO, ...voz.PERMISOS_CHAT_DUENO]) {
      assert.ok(permisos.includes(p), `el overwrite del dueño incluye ${String(p)}`);
    }
    assert.ok(permisos.includes(PermissionFlagsBits.SendMessages), 'SendMessages: la categoría no puede bloquear el panel');
  });
});

describe('bloqueos con duración (reapertura automática)', () => {
  const programadorReal = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  };

  test('bloquear 15 minutos: persiste el vencimiento, programa la reapertura y se reabre sola', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-timer', DUENO_ID);
    const programados = [];
    voz.fijarProgramadorReapertura((fn, ms) => programados.push({ fn, ms }));

    await voz.bloquearConDuracion(g, canal, 15 * 60_000, 'test', DUENO_ID);

    assert.ok(store.leer(GUILD_ID).voz.bloqueos['tmp-timer'] > Date.now(), 'vencimiento futuro persistido');
    assert.ok(canal.overwriteEdits.some((e) => e.id === 'role-everyone' && e.permisos[PermissionFlagsBits.Connect] === false), 'Connect denegado a @everyone');
    assert.equal(programados.length, 1, 'reapertura programada');
    assert.equal(programados[0].ms, 15 * 60_000);

    await programados[0].fn(); // el vencimiento dispara (reloj falso)
    assert.ok(canal.overwriteEdits.some((e) => e.permisos[PermissionFlagsBits.Connect] === null), 'Connect restaurado');
    assert.equal(store.leer(GUILD_ID).voz.bloqueos['tmp-timer'], undefined, 'bloqueo limpiado');
    voz.fijarProgramadorReapertura(programadorReal);
  });

  test('bloqueo indefinido: persiste (0), sin timer y sigue bloqueado tras un reinicio', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-inf', DUENO_ID);
    const programados = [];
    voz.fijarProgramadorReapertura((fn, ms) => programados.push({ fn, ms }));

    await voz.bloquearConDuracion(g, canal, 0, 'test', DUENO_ID);

    assert.equal(store.leer(GUILD_ID).voz.bloqueos['tmp-inf'], 0, '0 = indefinido');
    assert.equal(programados.length, 0, 'sin vencimiento no hay timer');

    await voz.restaurarBloqueos(g); // "reinicio"
    assert.equal(store.leer(GUILD_ID).voz.bloqueos['tmp-inf'], 0, 'sigue bloqueado tras el reinicio');
    voz.fijarProgramadorReapertura(programadorReal);
  });

  test('restaurarBloqueos: vencidos se reabren al arrancar y futuros se reprograman', async () => {
    const g = reset();
    const viejo = canalVozFake('tmp-viejo', g);
    const futuro = canalVozFake('tmp-futuro', g);
    g.channels.cache.set('tmp-viejo', viejo);
    g.channels.cache.set('tmp-futuro', futuro);
    store.escribir(GUILD_ID, { voz: { bloqueos: { 'tmp-viejo': Date.now() - 5_000, 'tmp-futuro': Date.now() + 60_000 } } });

    const programados = [];
    voz.fijarProgramadorReapertura((fn, ms) => programados.push({ fn, ms }));
    await voz.restaurarBloqueos(g);

    assert.ok(viejo.overwriteEdits.some((e) => e.permisos[PermissionFlagsBits.Connect] === null), 'vencido reabierto');
    assert.equal(store.leer(GUILD_ID).voz.bloqueos['tmp-viejo'], undefined);
    assert.equal(programados.length, 1, 'futuro reprogramado');
    assert.ok(programados[0].ms > 55_000 && programados[0].ms <= 60_000);
    voz.fijarProgramadorReapertura(programadorReal);
  });

  test('re-bloquear mientras esperaba: el timer viejo no reabre el bloqueo nuevo', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-rebloq', DUENO_ID);
    const programados = [];
    voz.fijarProgramadorReapertura((fn, ms) => programados.push({ fn, ms }));

    await voz.bloquearConDuracion(g, canal, 5 * 60_000, 'test', DUENO_ID);
    const timerViejo = programados[0].fn;
    await voz.bloquearConDuracion(g, canal, 60 * 60_000, 'test', DUENO_ID); // re-bloqueo
    assert.equal(programados.length, 2);
    const venceNuevo = store.leer(GUILD_ID).voz.bloqueos['tmp-rebloq'];

    await timerViejo(); // venció el PRIMER bloqueo
    assert.equal(store.leer(GUILD_ID).voz.bloqueos['tmp-rebloq'], venceNuevo, 'sigue el bloqueo nuevo, el viejo no reabrió');
    voz.fijarProgramadorReapertura(programadorReal);
  });

  test('cierre temporizado desde el menú de ajustes (5 minutos)', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-cierre', DUENO_ID);
    const programados = [];
    voz.fijarProgramadorReapertura((fn, ms) => programados.push({ fn, ms }));

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:avanzado', values: ['cierre:5'] });
    await voz.manejarSelect(i);

    assert.match(i.followUps[0].content, /cerrado por 5 minutos/);
    assert.equal(programados.length, 1);
    assert.equal(programados[0].ms, 5 * 60_000);
    assert.ok(store.leer(GUILD_ID).voz.bloqueos['tmp-cierre'] > Date.now());
    voz.fijarProgramadorReapertura(programadorReal);
  });
});

describe('permitidos y bloqueados (overwrites de Connect)', () => {
  test('permitir da Connect/View/Send aunque el canal esté cerrado', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-inv', DUENO_ID);
    g.members.cache.set('u-invi', miembroFake('u-invi', { displayName: 'Invitado' }));

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:permitir', values: ['u-invi'] });
    await voz.manejarSelect(i);

    const edit = canal.overwriteEdits.at(-1);
    assert.equal(edit.id, 'u-invi');
    assert.equal(edit.permisos[PermissionFlagsBits.Connect], true);
    assert.equal(edit.permisos[PermissionFlagsBits.SendMessages], true);
    assert.match(i.followUps[0].content, /Invitado/);
  });

  test('bloquear niega Connect y expulsa al que estaba adentro', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-bloq', DUENO_ID);
    const molesto = miembroFake('u-molesto', { displayName: 'Molesto' });
    canal.members.set('u-molesto', molesto);
    g.members.cache.set('u-molesto', molesto);

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:bloquear', values: ['u-molesto'] });
    await voz.manejarSelect(i);

    const edit = canal.overwriteEdits.at(-1);
    assert.equal(edit.permisos[PermissionFlagsBits.Connect], false);
    assert.equal(molesto.disconnects.length, 1, 'expulsado para que el bloqueo aplique ya');
  });

  test('no se puede bloquear al dueño del canal', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-dueno', DUENO_ID);

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:bloquear', values: [DUENO_ID] });
    await voz.manejarSelect(i);

    assert.match(i.followUps[0].content, /bloquear al dueño/);
    assert.equal(voz.estaBloqueado(canal, DUENO_ID), false);
  });

  test('permitidosDe y estaBloqueado leen los overwrites del canal', () => {
    const everyone = 'role-everyone';
    const CONNECT = PermissionFlagsBits.Connect;
    const canal = {
      permissionOverwrites: {
        cache: new Map([
          [everyone, { id: everyone, allow: 0n, deny: BigInt(CONNECT) }],
          ['u-ok', { id: 'u-ok', allow: BigInt(CONNECT), deny: 0n }],
          ['u-no', { id: 'u-no', allow: 0n, deny: BigInt(CONNECT) }],
          ['u-otro', { id: 'u-otro', allow: BigInt(PermissionFlagsBits.Speak), deny: 0n }],
        ]),
      },
    };

    assert.deepEqual(
      voz.permitidosDe(canal, everyone).map((x) => [x.id, x.tipo]),
      [
        ['u-ok', 'permitido'],
        ['u-no', 'bloqueado'],
      ],
      'ignora a @everyone y a overwrites sin Connect'
    );
    assert.equal(voz.estaBloqueado(canal, 'u-no'), true);
    assert.equal(voz.estaBloqueado(canal, 'u-ok'), false);
    assert.equal(voz.estaBloqueado(canal, 'u-otro'), false);
  });
});

describe('bitrate y región RTC', () => {
  test('validadores: rangos de Discord y región desconocida', () => {
    assert.equal(voz.bitrateValido(8000), 8000);
    assert.equal(voz.bitrateValido(96_000), 96_000);
    assert.equal(voz.bitrateValido(384_000), 384_000, 'máximo con nivel 3 de boosts');
    assert.equal(voz.bitrateValido(400_000), null, 'encima del máximo de Discord');
    assert.equal(voz.bitrateValido(0), 0, '0 = automático');
    assert.equal(voz.bitrateValido('nada'), null);
    assert.equal(voz.regionValida('europe'), 'europe');
    assert.equal(voz.regionValida('auto'), null, 'auto = automática (null)');
    assert.equal(voz.regionValida('marte'), undefined, 'región desconocida');
  });

  test('el dueño cambia el bitrate y lo vuelve a automático', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-br', DUENO_ID);

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:avanzado', values: ['bitrate:96000'] });
    await voz.manejarSelect(i);
    assert.equal(canal.bitrate, 96_000);
    assert.match(i.followUps[0].content, /96 kbps/);

    const iAuto = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:avanzado', values: ['bitrate:auto'] });
    await voz.manejarSelect(iAuto);
    assert.equal(canal.bitrate, 0, '0 = automático del server');
  });

  test('bitrate rechazado (falta de boosts): avisa con el motivo real', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-br-fail', DUENO_ID);
    canal.setBitrate = async () => {
      throw new Error('Invalid Form Body');
    };

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:avanzado', values: ['bitrate:256000'] });
    await voz.manejarSelect(i);

    assert.match(i.followUps[0].content, /rechazó el bitrate/);
    assert.match(i.followUps[0].content, /faltan boosts/);
  });

  test('región: fija una válida y "auto" restaura la automática', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-rg', DUENO_ID);

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:avanzado', values: ['region:europe'] });
    await voz.manejarSelect(i);
    assert.equal(canal.rtcRegion, 'europe');

    const iAuto = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:avanzado', values: ['region:auto'] });
    await voz.manejarSelect(iAuto);
    assert.equal(canal.rtcRegion, null);
  });

  test('región inválida: avisa sin tocar el canal', async () => {
    const g = reset();
    const { canal } = canalTemporalConDueno(g, 'tmp-rg-fail', DUENO_ID);

    const i = interactionPanelFake({ canal, userId: DUENO_ID, customId: 'voz:sel:avanzado', values: ['region:marte'] });
    await voz.manejarSelect(i);

    assert.match(i.followUps[0].content, /Región inválida/);
    assert.equal(canal.regionEdits.length, 0);
  });
});

describe('desactivarSistema (conservar vs borrar temporales)', () => {
  test('conservar: borra el hub, deja los temporales vivos y registrados', async () => {
    const g = reset();
    const hub = canalVozFake('hub-off', g);
    const t1 = canalVozFake('t-off-1', g);
    g.channels.cache.set('hub-off', hub);
    g.channels.cache.set('t-off-1', t1);
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-off' } });
    voz.registrarTemporal(GUILD_ID, 't-off-1', DUENO_ID);

    const res = await voz.desactivarSistema(g, { borrarTemporales: false });

    assert.equal(hub.borrado, true, 'hub eliminado');
    assert.equal(store.leer(GUILD_ID).voz.hubId, undefined, 'hub desconfigurado');
    assert.equal(res.total, 1);
    assert.equal(res.borrados, 0);
    assert.equal(t1.borrado, false, 'temporal conservado');
    assert.equal(voz.esTemporal(GUILD_ID, 't-off-1'), true);
  });

  test('borrar: elimina todos los temporales, limpia registros y bloqueos', async () => {
    const g = reset();
    const hub = canalVozFake('hub-off2', g);
    const t1 = canalVozFake('t-off-2', g);
    g.channels.cache.set('hub-off2', hub);
    g.channels.cache.set('t-off-2', t1);
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-off2', bloqueos: { 't-off-2': 0 } } });
    voz.registrarTemporal(GUILD_ID, 't-off-2', DUENO_ID);

    const res = await voz.desactivarSistema(g, { borrarTemporales: true });

    assert.equal(res.borrados, 1);
    assert.equal(res.total, 1);
    assert.equal(t1.borrado, true);
    assert.equal(Object.keys(voz.temporalesDe(GUILD_ID)).length, 0, 'registros limpiados');
    assert.equal(store.leer(GUILD_ID).voz.bloqueos?.['t-off-2'], undefined, 'bloqueo del canal limpiado');
  });
});

describe('límite de canales temporales (/voz limite canales)', () => {
  test('limiteCanalesValido acepta 1-50 y el default es 25', () => {
    reset();
    assert.equal(voz.limiteCanalesValido(1), 1);
    assert.equal(voz.limiteCanalesValido(25), 25);
    assert.equal(voz.limiteCanalesValido(50), 50);
    assert.equal(voz.limiteCanalesValido(0), null);
    assert.equal(voz.limiteCanalesValido(51), null);
    assert.equal(voz.limiteCanalesValido('hola'), null);
    assert.equal(voz.limiteCanales(GUILD_ID), 25, 'default sin configurar');
  });

  test('el límite configurado se respeta y el inválido cae al default', () => {
    reset();
    store.escribir(GUILD_ID, { voz: { limiteCanales: 3 } });
    assert.equal(voz.limiteCanales(GUILD_ID), 3);
    store.escribir(GUILD_ID, { voz: { limiteCanales: 500 } });
    assert.equal(voz.limiteCanales(GUILD_ID), 25, 'fuera de rango → default');
  });

  test('al alcanzar el límite: avisa en el hub y no crea el canal', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1', limiteCanales: 1 } });
    const hub = canalVozFake('hub-1', g);
    g.channels.cache.set('hub-1', hub);
    const dueno = miembroFake(DUENO_ID, { displayName: 'Federico' });
    const otro = miembroFake(OTRO_ID, { displayName: 'Nacho' });
    g.members.cache.set(DUENO_ID, dueno);
    g.members.cache.set(OTRO_ID, otro);

    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, dueno, 'hub-1'));
    assert.ok(voz.canalDeDueno(GUILD_ID, DUENO_ID), 'el primero entró bien');

    await voz.manejarCambio({ guild: g, channelId: null }, stateFake(g, otro, 'hub-1'));
    assert.equal(voz.canalDeDueno(GUILD_ID, OTRO_ID), null, 'el segundo no pudo crear: límite');
    assert.ok(hub.enviados.some((e) => JSON.stringify(e).includes('Límite de 1 canales temporales')), 'aviso con el motivo en el chat del hub');
  });
});

describe('persistencia agrupada (debounce de escritura)', () => {
  const FILE = path.join(process.env.TRIGGER_DATA_DIR, 'config.json');

  test('una ráfaga de mutaciones de voz genera UNA sola escritura (debounce)', async () => {
    store.volcar(); // limpia debounces pendientes de tests anteriores
    reset();
    const mtimeBase = fs.statSync(FILE).mtimeMs;

    // Ráfaga: 12 altas y 12 bajas sin esperar nada.
    for (let i = 0; i < 12; i++) voz.registrarTemporal(GUILD_ID, `rafaga-${i}`, DUENO_ID);
    for (let i = 0; i < 12; i++) voz.olvidarTemporal(GUILD_ID, `rafaga-${i}`);
    assert.deepEqual(Object.keys(voz.temporalesDe(GUILD_ID)), [], 'el cache ya quedó al día al instante');

    // El debounce (1,5 s) no venció: cero escrituras intermedias.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.statSync(FILE).mtimeMs, mtimeBase, 'durante el debounce no se escribe');

    // Vence: UNA escritura final con el estado correcto.
    await new Promise((r) => setTimeout(r, 1_500));
    const datos = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.deepEqual(Object.keys(datos[GUILD_ID].voz?.temporales ?? {}), []);
  });

  test('volcar() fuerza lo pendiente: el apagado controlado no pierde altas', () => {
    reset();
    voz.registrarTemporal(GUILD_ID, 'volcado-1', DUENO_ID);
    store.volcar();
    const datos = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.equal(datos[GUILD_ID].voz.temporales['volcado-1'], DUENO_ID);
  });
});

describe('/voz estado — diagnóstico operativo', () => {
  test('informa hub eliminado, huérfanos, canales fuera de categoría y ocupación sin modificar datos', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-fantasma', categoriaId: 'cat-1', limiteCanales: 2 } });
    g.channels.cache.set('cat-1', { id: 'cat-1', name: 'Cat', type: 4 });
    const vivo = canalVozFake('vivo-1', g);
    vivo.parentId = 'cat-otra'; // fuera de la categoría destino
    g.channels.cache.set('vivo-1', vivo);
    g.channels.cache.set('cat-otra', { id: 'cat-otra', name: 'Otra', type: 4 });
    voz.registrarTemporal(GUILD_ID, 'vivo-1', DUENO_ID);
    voz.registrarTemporal(GUILD_ID, 'muerto-1', OTRO_ID); // canal borrado a mano

    const bot = miembroFake('bot-voz', { bot: true });
    bot.permissions = { has: () => true };
    bot.permissionsIn = () => ({ has: () => true });
    g.members.me = bot;

    const replies = [];
    await comandoVoz.execute({
      options: { getSubcommand: () => 'estado' },
      guildId: GUILD_ID,
      guild: g,
      reply: async (p) => replies.push(p),
    });

    const texto = replies[0].embeds[0].data.description;
    assert.match(texto, /eliminado a mano/, 'hub eliminado manualmente');
    assert.match(texto, /registro\(s\) huérfano/, 'registros muertos');
    assert.match(texto, /fuera de la categoría/, 'canal fuera de la categoría destino');
    assert.match(texto, /Límite de canales alcanzado/, 'ocupación al 100%');
    assert.match(texto, /en uso: 2\/2/);
    assert.match(texto, /apagado \(recomendado\)/, 'fallback apagado por defecto');
    // Solo informa: no toca datos.
    assert.equal(voz.esTemporal(GUILD_ID, 'muerto-1'), true, 'los registros siguen intactos');
    assert.equal(vivo.borrado, false);
  });

  test('sin problemas: muestra el check verde', async () => {
    const g = reset();
    store.escribir(GUILD_ID, { voz: { hubId: 'hub-1' } });
    const hub = canalVozFake('hub-1', g);
    g.channels.cache.set('hub-1', hub);
    const bot = miembroFake('bot-voz', { bot: true });
    bot.permissions = { has: () => true };
    bot.permissionsIn = () => ({ has: () => true });
    g.members.me = bot;

    const replies = [];
    await comandoVoz.execute({
      options: { getSubcommand: () => 'estado' },
      guildId: GUILD_ID,
      guild: g,
      reply: async (p) => replies.push(p),
    });

    assert.match(replies[0].embeds[0].data.description, /Sin problemas operativos/);
  });
});
