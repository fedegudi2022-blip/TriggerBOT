// Sorteos: reglas de negocio (duración, cupos, requisitos, ganadores) y el cierre
// automático contra un cliente falso. Lo que se fija acá es lo que el bot promete:
// nadie entra dos veces, un sorteo vencido se cierra y anuncia solo, y no se informa
// un ganador que no existe.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRIGGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-sorteos-'));

const { MessageFlags } = require('discord.js');
const sorteos = require('../src/utils/sorteos');
const { getGuildConfig } = require('../src/store');

const MIEMBRO = (id, roles = []) => ({ id, roles: { cache: { has: (rolId) => roles.includes(rolId) } } });

describe('duración de un sorteo', () => {
  test('acepta minutos, horas, días y segundos, con o sin unidad explícita', () => {
    assert.equal(sorteos.parsearDuracion('30m'), 30 * 60_000);
    assert.equal(sorteos.parsearDuracion('2h'), 2 * 3600_000);
    assert.equal(sorteos.parsearDuracion('7d'), 7 * 86400_000);
    assert.equal(sorteos.parsearDuracion('90s'), 90_000);
    // Sin unidad se asume minutos (mismo criterio que /tempban).
    assert.equal(sorteos.parsearDuracion('15'), 15 * 60_000);
    assert.equal(sorteos.parsearDuracion(' 2H '), 2 * 3600_000);
  });

  test('rechaza lo que no es una duración o queda fuera del rango', () => {
    for (const invalida of ['', '   ', 'mañana', '0m', '-5m', '31d', '2 semanas', '1h30m', '99999d']) {
      assert.equal(sorteos.parsearDuracion(invalida), null, `debería rechazar "${invalida}"`);
    }
  });
});

describe('crear un sorteo', () => {
  test('valida premio, duración y cupo de sorteos abiertos', () => {
    const guildId = 'g-crear-validaciones';
    assert.match(sorteos.crear(guildId, { premio: '   ', hasta: Date.now() + 60_000 }).error, /vacío/);
    assert.match(sorteos.crear(guildId, { premio: 'x'.repeat(201), hasta: Date.now() + 60_000 }).error, /200/);
    assert.match(sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() - 1 }).error, /al menos 1 minuto/);
    assert.match(
      sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + sorteos.DURACION_MAXIMA_MS + 60_000 }).error,
      /30 días/
    );
  });

  test('numera los sorteos, guarda el creador y arranca abierto y sin participantes', () => {
    const guildId = 'g-crear-ok';
    const primero = sorteos.crear(guildId, { premio: 'Skin AK-47', hasta: Date.now() + 3600_000, creadorId: 'staff-1' });
    assert.equal(primero.sorteo.id, 1);
    assert.equal(primero.sorteo.estado, 'abierto');
    assert.deepEqual(primero.sorteo.participantes, []);
    assert.equal(primero.sorteo.premio, 'Skin AK-47');
    assert.equal(primero.sorteo.creadorId, 'staff-1');

    const segundo = sorteos.crear(guildId, { premio: 'Rango VIP', hasta: Date.now() + 3600_000, ganadores: 99 });
    assert.equal(segundo.sorteo.id, 2);
    // Los ganadores se acotan al máximo real, no se guardan 99.
    assert.equal(segundo.sorteo.ganadores, sorteos.MAX_GANADORES);
    assert.equal(sorteos.abiertos(guildId).length, 2);
  });

  test(`no deja pasar de ${sorteos.MAX_ABIERTOS} sorteos abiertos a la vez`, () => {
    const guildId = 'g-crear-cupo';
    for (let i = 0; i < sorteos.MAX_ABIERTOS; i++) {
      assert.ok(sorteos.crear(guildId, { premio: `Premio ${i}`, hasta: Date.now() + 3600_000 }).sorteo);
    }
    const rechazado = sorteos.crear(guildId, { premio: 'Uno más', hasta: Date.now() + 3600_000 });
    assert.match(rechazado.error, /sorteos abiertos/);
  });
});

describe('participar y salir', () => {
  const guildId = 'g-participar';

  test('suma una sola vez a cada persona y permite salir', () => {
    const { sorteo } = sorteos.crear(guildId, { premio: 'Mouse', hasta: Date.now() + 3600_000 });
    const ana = MIEMBRO('ana');

    const primera = sorteos.entrar(guildId, sorteo.id, ana);
    assert.equal(primera.error, undefined);
    assert.deepEqual(primera.sorteo.participantes, ['ana']);

    const repetida = sorteos.entrar(guildId, sorteo.id, ana);
    assert.equal(repetida.yaEstaba, true);
    assert.deepEqual(sorteos.obtener(guildId, sorteo.id).participantes, ['ana']);

    const salida = sorteos.salir(guildId, sorteo.id, ana);
    assert.deepEqual(salida.sorteo.participantes, []);
    assert.equal(sorteos.salir(guildId, sorteo.id, ana).noEstaba, true);
  });

  test('respetan el rol de requisito', () => {
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000, rolId: 'rol-vip' });
    assert.match(sorteos.entrar(guildId, sorteo.id, MIEMBRO('pedro', [])).error, /rol/);
    assert.ok(sorteos.entrar(guildId, sorteo.id, MIEMBRO('pedro', ['rol-vip'])).sorteo);
  });

  test('no deja entrar a un sorteo terminado, cancelado o vencido', () => {
    const { sorteo } = sorteos.crear(guildId, { premio: 'Teclado', hasta: Date.now() + 3600_000 });
    sorteos.finalizar(guildId, sorteo.id, { forzar: true });
    assert.match(sorteos.entrar(guildId, sorteo.id, MIEMBRO('ana')).error, /terminó/);

    const { sorteo: otro } = sorteos.crear(guildId, { premio: 'Pad', hasta: Date.now() + 3600_000 });
    sorteos.cancelar(guildId, otro.id);
    assert.match(sorteos.entrar(guildId, otro.id, MIEMBRO('ana')).error, /cancelado/);

    const { sorteo: vencido } = sorteos.crear(guildId, { premio: 'Gorra', hasta: Date.now() + 3600_000 });
    const tarde = Date.now() + 7200_000;
    assert.match(sorteos.motivoNoParticipa(sorteos.obtener(guildId, vencido.id), MIEMBRO('ana'), { ahora: tarde }), /cerró/);
  });

  test('un sorteo inexistente avisa en vez de romper', () => {
    assert.match(sorteos.entrar(guildId, 9999, MIEMBRO('ana')).error, /no existe/);
    assert.match(sorteos.salir(guildId, 9999, MIEMBRO('ana')).error, /no existe/);
  });
});

describe('elegir ganadores', () => {
  test('devuelve gente distinta, sin repetir y nunca más que participantes', () => {
    const gente = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 20; i++) {
      const ganadores = sorteos.elegirGanadores(gente, 3);
      assert.equal(ganadores.length, 3);
      assert.equal(new Set(ganadores).size, 3);
      assert.ok(ganadores.every((id) => gente.includes(id)));
    }
    assert.equal(sorteos.elegirGanadores(gente, 99).length, 4);
    assert.deepEqual(sorteos.elegirGanadores([], 3), []);
    assert.deepEqual(sorteos.elegirGanadores(gente, 0), []);
  });

  test('el reroll evita a los ganadores anteriores si hay gente suficiente', () => {
    const participantes = ['a', 'b', 'c', 'd', 'e'];
    const ganadores = sorteos.elegirGanadores(participantes, 2, { excluir: ['a', 'b'] });
    assert.equal(ganadores.length, 2);
    assert.ok(!ganadores.includes('a') && !ganadores.includes('b'));
  });

  test('si no queda gente nueva, elige igual antes que dejar el reroll vacío', () => {
    const ganadores = sorteos.elegirGanadores(['a'], 1, { excluir: ['a'] });
    assert.deepEqual(ganadores, ['a']);
  });
});

describe('cerrar un sorteo', () => {
  test('sin forzar no cierra uno que todavía no venció', () => {
    const guildId = 'g-cerrar-temprano';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    assert.match(sorteos.finalizar(guildId, sorteo.id).error, /todavía no terminó/);
    assert.equal(sorteos.obtener(guildId, sorteo.id).estado, 'abierto');
  });

  test('con forzar cierra, elige ganadores y no se puede cerrar dos veces', () => {
    const guildId = 'g-cerrar-forzado';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000, ganadores: 2 });
    for (const id of ['ana', 'beto', 'caro']) sorteos.entrar(guildId, sorteo.id, MIEMBRO(id));

    const resultado = sorteos.finalizar(guildId, sorteo.id, { forzar: true });
    assert.equal(resultado.ganadores.length, 2);
    assert.equal(resultado.sorteo.estado, 'finalizado');
    assert.deepEqual(resultado.sorteo.ganadoresElegidos, resultado.ganadores);
    assert.match(sorteos.finalizar(guildId, sorteo.id, { forzar: true }).error, /ya está finalizado/);
  });

  test('sin participantes queda desierto, no "gana" a nadie', () => {
    const guildId = 'g-cerrar-vacio';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    const resultado = sorteos.finalizar(guildId, sorteo.id, { forzar: true });
    assert.deepEqual(resultado.ganadores, []);
    assert.equal(resultado.sorteo.estado, 'finalizado');
  });

  test('el reroll solo aplica a sorteos terminados con participantes', () => {
    const guildId = 'g-reroll';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    assert.match(sorteos.reroll(guildId, sorteo.id).error, /terminado/);

    sorteos.entrar(guildId, sorteo.id, MIEMBRO('ana'));
    sorteos.entrar(guildId, sorteo.id, MIEMBRO('beto'));
    sorteos.finalizar(guildId, sorteo.id, { forzar: true });

    const nuevo = sorteos.reroll(guildId, sorteo.id);
    assert.equal(nuevo.ganadores.length, 1);
    assert.equal(nuevo.sorteo.rerolls, 1);
  });

  test('cancelar un sorteo abierto lo deja cerrado sin ganadores', () => {
    const guildId = 'g-cancelar';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    const resultado = sorteos.cancelar(guildId, sorteo.id);
    assert.equal(resultado.sorteo.estado, 'cancelado');
    assert.deepEqual(resultado.sorteo.ganadoresElegidos, []);
    assert.match(sorteos.cancelar(guildId, sorteo.id).error, /ya está cancelado/);
  });
});

describe('panel del sorteo', () => {
  test('abierto: dos botones con el id real en el customId', () => {
    const guildId = 'g-panel-abierto';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    const { embed, components } = sorteos.vista(sorteo);

    assert.equal(components.length, 1);
    const [participar, salir] = components[0].components.map((b) => b.data);
    assert.equal(participar.custom_id, `sorteo:entrar:${sorteo.id}`);
    assert.equal(salir.custom_id, `sorteo:salir:${sorteo.id}`);

    const texto = JSON.stringify(embed.data);
    assert.match(texto, /Skin/);
    assert.match(texto, /Participar/);
  });

  test('terminado: sin botones y con los ganadores en el texto', () => {
    const guildId = 'g-panel-terminado';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    sorteos.entrar(guildId, sorteo.id, MIEMBRO('ana'));
    const final = sorteos.finalizar(guildId, sorteo.id, { forzar: true });

    const { embed, components } = sorteos.vista(final.sorteo);
    assert.deepEqual(components, []);
    assert.match(JSON.stringify(embed.data), /<@ana>/);
  });

  test('cancelado: sin botones y avisa que fue cancelado', () => {
    const guildId = 'g-panel-cancelado';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    const cancelado = sorteos.cancelar(guildId, sorteo.id).sorteo;
    const { embed, components } = sorteos.vista(cancelado);
    assert.deepEqual(components, []);
    assert.match(JSON.stringify(embed.data), /cancelado/);
  });
});

// ---------- Cliente falso para el cierre automático ----------
function clienteFalso({ guildId, guildName = 'Trigger', canalId, mensajeId, editados, enviados }) {
  const mensaje = {
    id: mensajeId,
    edit: async (payload) => {
      editados.push(payload);
    },
  };
  const canal = {
    id: canalId,
    messages: { fetch: async () => mensaje },
    send: async (payload) => {
      enviados.push(payload);
      return { id: 'mensaje-resultado' };
    },
  };
  const guilds = new Map([[guildId, { id: guildId, name: guildName }]]);
  return {
    guilds: { cache: guilds },
    channels: { cache: new Map([[canalId, canal]]), fetch: async () => canal },
    users: { fetch: async (id) => ({ id, send: async () => {} }) },
  };
}

describe('cierre automático (procesar)', () => {
  test('cierra los vencidos, repinta el panel y anuncia el resultado', async () => {
    const guildId = 'g-tick';
    const { sorteo } = sorteos.crear(guildId, {
      premio: 'Skin',
      hasta: Date.now() + 60_000,
      canalId: 'canal-sorteos',
      mensajeId: 'panel-1',
    });
    sorteos.entrar(guildId, sorteo.id, MIEMBRO('ana'));
    sorteos.entrar(guildId, sorteo.id, MIEMBRO('beto'));

    const editados = [];
    const enviados = [];
    const cliente = clienteFalso({ guildId, canalId: 'canal-sorteos', mensajeId: 'panel-1', editados, enviados });

    const resumen = await sorteos.procesar(cliente, { ahora: Date.now() + 61_000 });
    assert.equal(resumen.finalizados, 1);
    assert.equal(resumen.errores, 0);

    const guardado = sorteos.obtener(guildId, sorteo.id);
    assert.equal(guardado.estado, 'finalizado');
    assert.equal(guardado.ganadoresElegidos.length, 1);

    // El panel pierde los botones y el canal recibe el anuncio con el ganador.
    assert.equal(editados.length, 1);
    assert.deepEqual(editados[0].components, []);
    assert.equal(enviados.length, 1);
    assert.match(JSON.stringify(enviados[0].embeds[0].data), new RegExp(guardado.ganadoresElegidos[0]));
    assert.deepEqual(enviados[0].allowedMentions, { users: guardado.ganadoresElegidos });
  });

  test('no toca los sorteos que todavía no vencieron', async () => {
    const guildId = 'g-tick-abierto';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000, canalId: 'canal-2' });
    const editados = [];
    const enviados = [];
    const cliente = clienteFalso({ guildId, canalId: 'canal-2', mensajeId: 'panel-2', editados, enviados });

    const resumen = await sorteos.procesar(cliente);
    assert.deepEqual(resumen, { revisados: 0, finalizados: 0, errores: 0 });
    assert.equal(sorteos.obtener(guildId, sorteo.id).estado, 'abierto');
    assert.deepEqual(editados, []);
  });

  test('si el panel ya no existe, el sorteo se cierra igual', async () => {
    const guildId = 'g-tick-borrado';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 60_000, canalId: 'canal-3', mensajeId: 'panel-3' });
    sorteos.entrar(guildId, sorteo.id, MIEMBRO('ana'));

    const cliente = clienteFalso({ guildId, canalId: 'canal-3', mensajeId: 'panel-3', editados: [], enviados: [] });
    cliente.channels.cache.get('canal-3').messages.fetch = async () => {
      throw new Error('Unknown Message');
    };

    const resumen = await sorteos.procesar(cliente, { ahora: Date.now() + 61_000 });
    assert.equal(resumen.finalizados, 1);
    assert.equal(sorteos.obtener(guildId, sorteo.id).estado, 'finalizado');
  });
});

describe('botones del panel', () => {
  function interaccionFalsa({ guildId = 'g-botones', customId, member = MIEMBRO('ana') }) {
    const respuestas = [];
    return {
      respuestas,
      customId,
      guildId,
      guild: { id: guildId },
      member,
      reply: async (payload) => {
        respuestas.push(payload);
        return payload;
      },
    };
  }

  test('entrar desde el botón contesta en efímero y anota a la persona', async () => {
    const guildId = 'g-botones';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    const interaccion = interaccionFalsa({ guildId, customId: `sorteo:entrar:${sorteo.id}` });

    await sorteos.manejarBoton(interaccion);
    assert.equal(interaccion.respuestas.length, 1);
    assert.match(interaccion.respuestas[0].content, /Estás participando/);
    assert.deepEqual(sorteos.obtener(guildId, sorteo.id).participantes, ['ana']);
  });

  test('el segundo click avisa que ya está anotado sin duplicar', async () => {
    const guildId = 'g-botones-doble';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    const customId = `sorteo:entrar:${sorteo.id}`;
    await sorteos.manejarBoton(interaccionFalsa({ guildId, customId }));
    const segunda = interaccionFalsa({ guildId, customId });
    await sorteos.manejarBoton(segunda);
    assert.match(segunda.respuestas[0].content, /Ya estás participando/);
    assert.equal(sorteos.obtener(guildId, sorteo.id).participantes.length, 1);
  });

  test('salir del botón saca a la persona', async () => {
    const guildId = 'g-botones-salir';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000 });
    sorteos.entrar(guildId, sorteo.id, MIEMBRO('ana'));
    const interaccion = interaccionFalsa({ guildId, customId: `sorteo:salir:${sorteo.id}` });

    await sorteos.manejarBoton(interaccion);
    assert.match(interaccion.respuestas[0].content, /Saliste/);
    assert.deepEqual(sorteos.obtener(guildId, sorteo.id).participantes, []);
  });

  test('un error de requisito se informa tal cual', async () => {
    const guildId = 'g-botones-rol';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin', hasta: Date.now() + 3600_000, rolId: 'rol-vip' });
    const interaccion = interaccionFalsa({ guildId, customId: `sorteo:entrar:${sorteo.id}`, member: MIEMBRO('ana', []) });

    await sorteos.manejarBoton(interaccion);
    assert.match(interaccion.respuestas[0].content, /rol/);
    assert.deepEqual(sorteos.obtener(guildId, sorteo.id).participantes, []);
  });
});

describe('persistencia', () => {
  test('el estado viaja en la config del servidor (sobrevive reinicios y backup)', () => {
    const guildId = 'g-persistencia';
    const { sorteo } = sorteos.crear(guildId, { premio: 'Skin persistente', hasta: Date.now() + 3600_000 });
    sorteos.entrar(guildId, sorteo.id, MIEMBRO('ana'));

    const config = getGuildConfig(guildId);
    assert.ok(Array.isArray(config.sorteos));
    const guardado = config.sorteos.find((s) => s.id === sorteo.id);
    assert.equal(guardado.premio, 'Skin persistente');
    assert.deepEqual(guardado.participantes, ['ana']);
    assert.equal(config.sorteoSeq, sorteo.id);
  });
});

describe('/sorteo crear de punta a punta', () => {
  const { cargarComandos } = require('../src/commandLoader');
  const comando = cargarComandos().find((c) => c.data.name === 'sorteo');

  function interaccion({ guildId, opciones = {} }) {
    const enviados = [];
    const respuestas = [];
    const canal = {
      id: 'canal-sorteos',
      send: async (payload) => {
        enviados.push(payload);
        return { id: 'panel-publicado' };
      },
    };
    const interaccionFalsa = {
      guildId,
      guild: { id: guildId, ownerId: 'duenio', name: 'Trigger' },
      client: { channels: { cache: new Map([[canal.id, canal]]), fetch: async () => canal }, users: { fetch: async () => null } },
      user: { id: 'staff-1', username: 'staff' },
      member: { id: 'staff-1', permissions: { has: () => true }, roles: { cache: { has: () => false } } },
      channel: canal,
      options: {
        getSubcommand: () => 'crear',
        getString: (nombre) => opciones[nombre] ?? null,
        getInteger: (nombre) => opciones[nombre] ?? null,
        getChannel: () => null,
        getRole: () => opciones.rol ?? null,
        getBoolean: () => null,
      },
      reply: async (payload) => {
        respuestas.push(payload);
        return payload;
      },
      deferReply: async () => {},
      editReply: async (payload) => {
        respuestas.push(payload);
        return payload;
      },
    };
    return { interaccion: interaccionFalsa, enviados, respuestas };
  }

  test('publica el panel en el canal y confirma en efímero', async () => {
    const guildId = 'g-comando-crear';
    const { interaccion: i, enviados, respuestas } = interaccion({
      guildId,
      opciones: { premio: 'Skin AK-47', duracion: '2h', ganadores: 2 },
    });

    await comando.execute(i);

    assert.equal(enviados.length, 1, 'el panel se publica una vez');
    const panel = enviados[0];
    assert.equal(panel.components.length, 1);
    assert.deepEqual(panel.allowedMentions, { parse: [] });
    assert.match(JSON.stringify(panel.embeds[0].data), /Skin AK-47/);

    const guardado = sorteos.lista(guildId).at(-1);
    assert.equal(guardado.mensajeId, 'panel-publicado');
    assert.equal(guardado.canalId, 'canal-sorteos');

    assert.equal(respuestas.length, 1);
    assert.ok(respuestas[0].flags & MessageFlags.Ephemeral);
    assert.match(respuestas[0].embeds[0].data.description, /publicado/);
  });

  test('una duración inválida no publica nada', async () => {
    const { interaccion: i, enviados, respuestas } = interaccion({
      guildId: 'g-comando-duracion',
      opciones: { premio: 'Skin', duracion: 'para siempre' },
    });

    await comando.execute(i);
    assert.deepEqual(enviados, []);
    assert.match(respuestas[0].embeds[0].data.description, /duración/i);
  });

  test('si no puede publicar el panel, avisa y no deja el sorteo abierto', async () => {
    const guildId = 'g-comando-sin-permiso';
    const { interaccion: i, respuestas } = interaccion({ guildId, opciones: { premio: 'Skin', duracion: '1h' } });
    i.channel.send = async () => {
      throw new Error('Missing Permissions');
    };

    await comando.execute(i);
    assert.deepEqual(sorteos.abiertos(guildId), []);
    assert.match(respuestas[0].embeds[0].data.description, /No pude publicar/);
  });
});
