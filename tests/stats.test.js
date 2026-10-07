// Canales de estadísticas (utils/estadisticasServer.js + /stats).
// Lo que se prueba acá es la promesa del sistema: nombres con el número real (o «—» si no
// se pudo medir), canales de solo lectura, y renombres que respetan los 2 por canal cada
// 10 minutos que permite Discord sin perder el último valor.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-stats-'));

const { ChannelType, PermissionFlagsBits, GatewayIntentBits, MessageFlags } = require('discord.js');
const stats = require('../src/utils/estadisticasServer');
const censo = require('../src/utils/censo');
const comando = require('../src/commands/stats');
const { getGuildConfig } = require('../src/store');

function coleccion(items = []) {
  const mapa = new Map(items.map((i) => [i.id, i]));
  return {
    get: (id) => mapa.get(id),
    values: () => mapa.values(),
    get size() {
      return mapa.size;
    },
    filter: (fn) => coleccion([...mapa.values()].filter(fn)),
    [Symbol.iterator]: () => mapa.values(),
  };
}

function canalFake(id, { nombre = 'canal', tipo = ChannelType.GuildVoice } = {}) {
  const canal = {
    id,
    name: nombre,
    type: tipo,
    renombres: [],
    borrado: false,
    setName: async (nuevo) => {
      canal.renombres.push(nuevo);
      canal.name = nuevo;
    },
    delete: async () => {
      canal.borrado = true;
    },
  };
  return canal;
}

// Cada guild nace con su propio id: la config del store es por servidor y compartirla entre
// tests haría que uno herede lo que dejó el anterior.
let secuenciaGuild = 0;
function guildFake({ id = null, memberCount = 1234, conPresencias = true, roles = 5, boosts = 3, miembros = [], fetch = null } = {}) {
  const mapa = new Map();
  const creados = [];
  let contador = 0;

  const guild = {
    id: id ?? `g${(secuenciaGuild += 1)}`,
    name: 'TriggerArena',
    memberCount,
    premiumSubscriptionCount: boosts,
    roles: { cache: { size: roles }, everyone: { id: 'everyone' } },
    client: { options: { intents: { has: (flag) => conPresencias === true && flag === GatewayIntentBits.GuildPresences } } },
    channels: {
      cache: {
        get: (canalId) => mapa.get(canalId),
        get size() {
          return mapa.size;
        },
        values: () => mapa.values(),
      },
      create: async (payload) => {
        contador += 1;
        const canal = canalFake(`c${contador}`, { nombre: payload.name, tipo: payload.type });
        canal.payload = payload;
        mapa.set(canal.id, canal);
        creados.push(canal);
        return canal;
      },
    },
    members: {
      fetch: fetch ?? (async () => coleccion(miembros)),
      cache: coleccion([]),
    },
  };

  // El cache es mutable: los tests borran canales para simular que alguien los tocó a mano.
  guild.quitarCanal = (canalId) => mapa.delete(canalId);
  guild.creados = creados;
  return guild;
}

beforeEach(() => {
  stats.reiniciar();
  censo.reiniciar();
});

describe('catálogo de métricas', () => {
  test('normaliza la lista escrita a mano (alias, tildes, espacios y repetidos)', () => {
    assert.deepEqual(stats.normalizarMetricas('miembros, en línea, humanos'), ['miembros', 'enLinea', 'humanos']);
    assert.deepEqual(stats.normalizarMetricas('ONLINE;boost'), ['enLinea', 'boosts']);
    assert.deepEqual(stats.normalizarMetricas('miembros,miembros'), ['miembros']);
    assert.deepEqual(stats.normalizarMetricas('inventado'), [], 'lo que no existe no crea canales');
    assert.deepEqual(stats.normalizarMetricas(null), []);
  });

  test('el nombre lleva el número y, sin dato, un guion (nunca un 0 inventado)', () => {
    assert.equal(stats.nombreDeMetrica('roles', 40), '🎭 Roles: 40');
    assert.equal(stats.nombreDeMetrica('miembros', 87614), `👥 Miembros: ${(87614).toLocaleString('es-AR')}`);
    assert.equal(stats.nombreDeMetrica('enLinea', null), `🟢 En línea: ${stats.SIN_DATO}`);
    assert.equal(stats.nombreDeMetrica('inexistente', 1), null);
    for (const m of stats.METRICAS) assert.ok(stats.nombreDeMetrica(m.id, 1234567).length <= 100);
  });

  test('las métricas por defecto son las de la ficha del servidor', () => {
    assert.deepEqual(stats.metricasPorDefecto(), ['miembros', 'enLinea', 'roles']);
  });
});

describe('activar y cambiar métricas', () => {
  test('activar crea la categoría, los canales de solo lectura y guarda la config', async () => {
    const guild = guildFake();
    const resultado = await stats.activar(guild);

    assert.equal(resultado.ok, true);
    assert.equal(resultado.creados.length, 3);
    assert.equal(guild.creados[0].payload.type, ChannelType.GuildCategory, 'sin categoría elegida, el bot crea una');
    assert.equal(guild.creados[0].payload.name, stats.NOMBRE_CATEGORIA);

    const canales = guild.creados.slice(1);
    assert.deepEqual(
      canales.map((c) => c.name),
      [`👥 Miembros: ${(1234).toLocaleString('es-AR')}`, `🟢 En línea: ${stats.SIN_DATO}`, '🎭 Roles: 5']
    );
    for (const canal of canales) {
      assert.equal(canal.payload.type, ChannelType.GuildVoice);
      assert.ok(canal.payload.permissionOverwrites[0].deny.includes(PermissionFlagsBits.Connect), 'nadie tiene que poder entrar a hablar ahí');
    }

    const config = getGuildConfig(guild.id).stats;
    assert.equal(config.activado, true);
    assert.deepEqual(config.metricas, ['miembros', 'enLinea', 'roles']);
    assert.equal(Object.keys(config.canales).length, 3);
    assert.equal(stats.activo(guild.id), true);
  });

  test('con el censo ya hecho, «en línea» sale con el número real', async () => {
    const guild = guildFake({
      miembros: [
        { id: 'u1', user: { bot: false }, presence: { status: 'online' } },
        { id: 'u2', user: { bot: false }, presence: { status: 'offline' } },
      ],
    });
    await censo.sembrar(guild);
    await stats.activar(guild);

    const enLinea = guild.creados.find((c) => c.name.startsWith('🟢'));
    assert.equal(enLinea.name, '🟢 En línea: 1');
  });

  test('volver a activar no duplica canales: los reutiliza', async () => {
    const guild = guildFake();
    await stats.activar(guild);
    const antes = guild.creados.length;

    const segundo = await stats.activar(guild);

    assert.equal(guild.creados.length, antes);
    assert.equal(segundo.creados.length, 0);
    assert.equal(Object.keys(getGuildConfig(guild.id).stats.canales).length, 3);
  });

  test('cambiar métricas crea las nuevas y borra las que salen', async () => {
    const guild = guildFake();
    await stats.activar(guild);
    const rolesId = getGuildConfig(guild.id).stats.canales.roles;

    const resultado = await stats.cambiarMetricas(guild, 'humanos, boosts');

    assert.deepEqual(resultado.ids, ['humanos', 'boosts']);
    assert.equal(resultado.creados.length, 2);
    assert.equal(resultado.borrados.length, 3);
    assert.equal(guild.channels.cache.get(rolesId).borrado, true);
    assert.deepEqual(getGuildConfig(guild.id).stats.metricas, ['humanos', 'boosts']);
  });

  test('una lista sin métricas válidas no toca nada', async () => {
    const guild = guildFake();
    await stats.activar(guild);
    const antes = { ...getGuildConfig(guild.id).stats };

    const resultado = await stats.cambiarMetricas(guild, 'cualquier-cosa');

    assert.equal(resultado.ok, false);
    assert.deepEqual(getGuildConfig(guild.id).stats, antes, 'la config tiene que quedar intacta');
  });

  test('desactivar borra los canales y apaga el sistema (o los conserva si se pide)', async () => {
    const guild = guildFake();
    await stats.activar(guild);
    const canales = Object.values(getGuildConfig(guild.id).stats.canales);

    const conservando = await stats.desactivar(guild, { borrar: false });
    assert.equal(conservando.borrados.length, 0);
    assert.equal(guild.channels.cache.get(canales[0]).borrado, false);
    assert.equal(stats.activo(guild.id), false);

    await stats.activar(guild);
    const borrando = await stats.desactivar(guild, { borrar: true });
    assert.equal(borrando.borrados.length, 3);
    assert.deepEqual(getGuildConfig(guild.id).stats.canales, {});
    assert.deepEqual(getGuildConfig(guild.id).stats.metricas, ['miembros', 'enLinea', 'roles'], 'las métricas quedan para volver a activar');
  });
});

describe('refresco', () => {
  test('renombra solo lo que cambió y respeta el cupo de 2 por canal cada 10 minutos', async () => {
    const guild = guildFake({ memberCount: 1000 });
    await stats.activar(guild);
    const miembrosId = getGuildConfig(guild.id).stats.canales.miembros;
    const canal = guild.channels.cache.get(miembrosId);

    // Primera pasada con el mismo valor: no se toca la API.
    const igual = await stats.refrescarGuild(guild);
    assert.equal(igual.resultados.find((r) => r.id === 'miembros').estado, 'sin-cambio');
    assert.equal(canal.renombres.length, 0);

    // Ahora cambia el número: primer renombre de la ventana.
    guild.memberCount = 1001;
    const primera = await stats.refrescarGuild(guild);
    assert.equal(primera.resultados.find((r) => r.id === 'miembros').estado, 'renombrado');

    guild.memberCount = 1002;
    const segunda = await stats.refrescarGuild(guild);
    assert.equal(segunda.resultados.find((r) => r.id === 'miembros').estado, 'renombrado');

    // Tercero en la misma ventana: queda agendado, con el valor nuevo prometido.
    guild.memberCount = 1003;
    const tercera = await stats.refrescarGuild(guild);
    const r = tercera.resultados.find((x) => x.id === 'miembros');
    assert.equal(r.estado, 'espera');
    assert.match(r.objetivo, /1\.003/);
    assert.equal(canal.name, `👥 Miembros: ${(1002).toLocaleString('es-AR')}`, 'no se insiste contra el límite de Discord');
  });

  test('un canal borrado se reporta como perdido en vez de romper la pasada', async () => {
    const guild = guildFake();
    await stats.activar(guild);
    guild.quitarCanal(getGuildConfig(guild.id).stats.canales.roles);

    const { resultados } = await stats.refrescarGuild(guild);
    assert.equal(resultados.find((r) => r.id === 'roles').estado, 'perdido');
  });

  test('la lectura de «Humanos» espera la foto del censo: mientras tanto muestra el guion', async () => {
    // El censo de fondo que dispara cambiarMetricas falla (sin permiso): no hay foto.
    const guild = guildFake({
      fetch: async () => {
        throw new Error('Missing Permissions');
      },
    });
    await stats.cambiarMetricas(guild, 'humanos');
    assert.equal(stats.nombreDeMetrica('humanos', stats.valorDeMetrica(guild, 'humanos')), `🧑 Humanos: ${stats.SIN_DATO}`);

    guild.members.fetch = async () =>
      coleccion([
        { id: 'u1', user: { bot: false }, presence: { status: 'online' } },
        { id: 'b1', user: { bot: true }, presence: { status: 'online' } },
      ]);
    await censo.sembrar(guild);
    assert.equal(stats.valorDeMetrica(guild, 'humanos'), guild.memberCount - 1);
  });

  test('la pasada general saltea los servidores que no lo tienen activado', async () => {
    const conStats = guildFake({ id: 'g-activo' });
    const sinStats = guildFake({ id: 'g-apagado' });
    await stats.activar(conStats);

    const resumen = await stats.refrescar({ guilds: { cache: coleccion([conStats, sinStats]) } });

    assert.equal(resumen.guilds, 1);
    assert.equal(sinStats.creados.length, 0);
  });
});

// ---------- El comando como lo usa el staff ----------
// La batería de contrato solo ejecuta el PRIMER subcomando de cada comando: acá se corren
// los cinco, que es la interfaz real de /stats.
function interaccionFake(guild, sub, valores = {}, { staff = true } = {}) {
  const capturadas = [];
  const miembro = {
    id: staff ? 'staff' : 'raso',
    permissions: { has: () => staff },
    roles: { cache: { has: () => false } },
  };

  return {
    capturadas,
    client: guild.client,
    guild,
    guildId: guild.id,
    user: { id: miembro.id, username: 'staff' },
    member: miembro,
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => sub,
      getChannel: () => valores.categoria ?? null,
      getString: () => valores.lista ?? valores.metricas ?? null,
      getBoolean: () => valores.borrar ?? null,
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
  return [json.title, json.description, json.footer?.text, ...(json.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n');
}

describe('el comando /stats', () => {
  test('sin permiso avisa en efímero y no toca nada', async () => {
    const guild = guildFake();
    const interaccion = interaccionFake(guild, 'activar', {}, { staff: false });

    await comando.execute(interaccion);

    assert.equal(guild.creados.length, 0);
    assert.ok(interaccion.capturadas[0].flags & MessageFlags.Ephemeral);
    assert.match(textoDe(interaccion.capturadas[0]), /solo para el staff/i);
  });

  test('activar, estado, refrescar, metricas y desactivar contestan lo que pasó de verdad', async () => {
    const guild = guildFake({
      miembros: [
        { id: 'u1', user: { bot: false }, presence: { status: 'online' } },
        { id: 'b1', user: { bot: true }, presence: { status: 'online' } },
      ],
    });

    const activar = interaccionFake(guild, 'activar', { lista: 'miembros,enLinea' });
    await comando.execute(activar);
    assert.match(textoDe(activar.capturadas[0]), /Canales activos: `miembros` · `enLinea`/);
    assert.match(textoDe(activar.capturadas[0]), /2 renombres por canal cada 10 minutos/);

    const estado = interaccionFake(guild, 'estado');
    await comando.execute(estado);
    const textoEstado = textoDe(estado.capturadas[0]);
    assert.match(textoEstado, /Estado:\*\* 🟢 Activo/);
    assert.match(textoEstado, /Presence Intent:\*\* activo/);
    assert.match(textoEstado, /— \*\*1\*\* · se renombra a `🟢 En línea: 1`/, 'el en línea del censo sale en el estado');
    assert.match(textoEstado, /`humanos`/, 'el catálogo completo se muestra para poder elegir');

    guild.memberCount = 4321;
    const refrescar = interaccionFake(guild, 'refrescar');
    await comando.execute(refrescar);
    assert.match(textoDe(refrescar.capturadas[0]), /✅ `miembros` → `👥 Miembros: 4\.321`/);

    const metricas = interaccionFake(guild, 'metricas', { lista: 'roles' });
    await comando.execute(metricas);
    assert.match(textoDe(metricas.capturadas[0]), /Ahora se muestran: `roles`/);
    assert.match(textoDe(metricas.capturadas[0]), /Borrados: `miembros` · `enLinea`/);

    const desactivar = interaccionFake(guild, 'desactivar', { borrar: true });
    await comando.execute(desactivar);
    assert.match(textoDe(desactivar.capturadas[0]), /Sistema \*\*apagado\*\* y 1 de 1 canal\(es\) borrados/);
    assert.equal(stats.activo(guild.id), false);
  });

  test('una categoría que no es categoría se rechaza con el motivo', async () => {
    const guild = guildFake();
    const texto = { id: 'canal-texto', type: ChannelType.GuildText, name: 'general' };
    guild.channels.cache.get = (canalId) => (canalId === texto.id ? texto : null);

    const interaccion = interaccionFake(guild, 'activar', { categoria: texto });
    await comando.execute(interaccion);

    assert.equal(guild.creados.length, 0);
    assert.match(textoDe(interaccion.capturadas[0]), /no es una \*\*categoría\*\*/);
  });

  test('refrescar sin el sistema activado no finge un refresco', async () => {
    const guild = guildFake();
    const interaccion = interaccionFake(guild, 'refrescar');

    await comando.execute(interaccion);

    assert.match(textoDe(interaccion.capturadas[0]), /no tiene los canales de estadísticas activados/);
  });
});

describe('diagnóstico', () => {
  test('avisa cuando falta un canal, cuando no hay presencias y cuando Discord rechazó un renombre', async () => {
    const sinPresencias = guildFake({ conPresencias: false });
    const problemas = stats.diagnosticoStats(sinPresencias);
    assert.equal(problemas.length, 0, 'apagado no es un problema: es una configuración válida');

    await stats.activar(sinPresencias);
    assert.match(
      stats
        .diagnosticoStats(sinPresencias)
        .map((p) => p.texto)
        .join('\n'),
      /Presence Intent/
    );

    // Alguien borró un canal a mano: el diagnóstico tiene que decirlo.
    sinPresencias.quitarCanal(getGuildConfig(sinPresencias.id).stats.canales.roles);
    assert.match(
      stats
        .diagnosticoStats(sinPresencias)
        .map((p) => p.texto)
        .join('\n'),
      /Faltan 1 canal/
    );

    const guild = guildFake();
    await stats.activar(guild);
    const canal = guild.channels.cache.get(getGuildConfig(guild.id).stats.canales.miembros);
    canal.setName = async () => {
      throw new Error('Missing Permissions');
    };
    guild.memberCount = 9999;
    await stats.refrescarGuild(guild);

    assert.match(
      stats
        .diagnosticoStats(guild)
        .map((p) => p.texto)
        .join('\n'),
      /Gestionar canales/
    );
  });
});
