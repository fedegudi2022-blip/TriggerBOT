// Cliente mínimo del protocolo de consulta de servidores de Valve (A2S) sobre UDP.
// Docs: https://developer.valvesoftware.com/wiki/Server_queries
// Sirve para CS 1.6 (y la mayoría de los juegos GoldSrc/Source). Sin dependencias externas.
//
//   A2S_INFO    → nombre, mapa, jugadores, máximo, ...
//   A2S_PLAYER  → lista de jugadores conectados
//
// Uso: const info = await consultar('cs.nostalgia.ar', 27015);

const dgram = require('node:dgram');

const MAGIC = -1; // header de paquete simple: 0xFFFFFFFF
const A2S_INFO = 'Source Engine Query'; // payload del desafío para juegos GoldSrc/Source modernos
const A2S_PLAYER_CHALLENGE = 0x55; // 'U'
const A2S_PLAYER_RESPONSE = 0x44; // 'D'
const A2S_INFO_RESPONSE_GOLDSRC = 0x6d; // 'm' (viejo formato GoldSrc)
const A2S_INFO_RESPONSE_SOURCE = 0x49; // 'I' (formato Source)

// Lectura incremental de un Buffer: strings terminadas en \0, enteros de 1/2/4 bytes y floats.
function crearLector(buffer) {
  let pos = 0;
  return {
    pos: () => pos,
    byte() {
      const v = buffer.readUInt8(pos);
      pos += 1;
      return v;
    },
    corto() {
      const v = buffer.readInt16LE(pos);
      pos += 2;
      return v;
    },
    entero() {
      const v = buffer.readInt32LE(pos);
      pos += 4;
      return v;
    },
    flotante() {
      const v = buffer.readFloatLE(pos);
      pos += 4;
      return v;
    },
    // Lee bytes hasta encontrar 0x00 y devuelve el texto (encoding latino: latin1).
    cadena() {
      const fin = buffer.indexOf(0x00, pos);
      if (fin === -1) {
        const v = buffer.subarray(pos).toString('latin1');
        pos = buffer.length;
        return v;
      }
      const v = buffer.subarray(pos, fin).toString('latin1');
      pos = fin + 1;
      return v;
    },
  };
}

// Envia un paquete UDP y espera la respuesta (con timeout y una corroboración simple).
function udpConsulta(host, puerto, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let terminado = false;

    const fallar = (error) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(vigilante);
      try {
        socket.close();
      } catch {}
      reject(error);
    };

    const vigilante = setTimeout(() => fallar(new Error('timeout')), timeoutMs);

    socket.on('message', (msg, rinfo) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(vigilante);
      try {
        socket.close();
      } catch {}
      resolve({ msg, rinfo });
    });

    socket.on('error', fallar);
    socket.send(payload, puerto, host, (error) => {
      if (error) fallar(error);
    });
  });
}

// Un paquete puede llegar fragmentado: junta los pedazos con header múltiple (0xFFFFFFFE).
function ensamblar(paquetes) {
  if (paquetes.length === 1) return paquetes[0].cuerpo;
  // Los paquetes de Source llevan un entero con el ID y un byte de posición;
  // para las respuestas de A2S alcanza con concatenarlos en orden.
  const ordenados = [...paquetes].sort((a, b) => a.indice - b.indice);
  return Buffer.concat(ordenados.map((p) => p.cuerpo));
}

// Parsea uno o más datagramas crudos y devuelve el payload completo tras el header.
function leerRespuesta(datagramas) {
  const paquetes = datagramas.map((msg) => {
    const lector = crearLector(msg);
    const header = lector.entero();
    if (header === MAGIC) return { multiple: false, cuerpo: msg.subarray(4) };
    if (header === -2) {
      // Formato Source: id (4), total (1), índice (1), tamaño (2) y cuerpo. El payload
      // útil empieza en el byte 10 (no en el 9: falta saltar el id completo).
      lector.entero(); // id
      const total = lector.byte();
      const indice = lector.byte();
      lector.corto(); // tamaño del paquete (no lo necesitamos)
      const cuerpo = msg.subarray(10);
      return { multiple: true, total, indice, cuerpo };
    }
    // Nota: CS 1.6 responde A2S_INFO y A2S_PLAYER en un solo datagrama, así que el
    // formato GoldSrc multi-packet no se da en la práctica para estas consultas.
    throw new Error(`header de respuesta desconocido: ${header} (${msg.subarray(0, 12).toString('hex')})`);
  });

  if (paquetes.length === 1) return paquetes[0].cuerpo;

  // Si llegaron de a partes, verificamos que estén todas antes de unir.
  const total = paquetes[0].total;
  if (paquetes.length < total) throw new Error(`respuesta fragmentada incompleta (${paquetes.length}/${total})`);
  return ensamblar(paquetes);
}

// Paquete A2S_INFO: header + 'T' + "Source Engine Query\0" (string COMPLETO, 25 bytes base)
// y opcionalmente el challenge de 4 bytes al final.
function paqueteInfo(desafio) {
  const base = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
    Buffer.from(A2S_INFO + '\0', 'latin1'),
  ]);
  return desafio ? Buffer.concat([base, desafio]) : base;
}

// A2S_INFO: consulta el estado general del server.
async function infoServer(host, puerto, opciones = {}) {
  const timeout = opciones.timeoutMs ?? 3000;
  const datagramas = [];

  // Primer intento: los servers modernos suelen responder directo al desafío incluido.
  let res = await udpConsulta(host, puerto, paqueteInfo(), timeout);
  datagramas.push(res.msg);

  let cuerpo = leerRespuesta(datagramas);
  let lector = crearLector(cuerpo);
  let tipo = lector.byte();

  // Si respondió con desafío (0x41 'A'), reenviamos con el desafío.
  if (tipo === 0x41) {
    const desafio = cuerpo.subarray(1).subarray(0, 4);
    res = await udpConsulta(host, puerto, paqueteInfo(desafio), timeout);
    datagramas.length = 0;
    datagramas.push(res.msg);
    cuerpo = leerRespuesta(datagramas);
    lector = crearLector(cuerpo);
    tipo = lector.byte();
  }

  if (tipo === A2S_INFO_RESPONSE_GOLDSRC) {
    // Formato GoldSrc ('m'): direccion, nombre, mapa, carpeta, juego y DESPUÉS
    // jugadores (1 byte), max (1 byte) y protocolo (1 byte) — sin ningún appid en el medio.
    // (Leer un short acá corridaba todo: reportaba 47/100 en cualquier server.)
    lector.cadena(); // direccion
    const nombre = lector.cadena();
    const mapa = lector.cadena();
    lector.cadena(); // carpeta
    lector.cadena(); // juego
    const jugadores = lector.byte();
    const maximo = lector.byte();
    const protocolo = lector.byte();
    return { nombre, mapa, jugadores, maximo, protocolo, vacante: null, bot: null };
  }

  if (tipo !== A2S_INFO_RESPONSE_SOURCE) throw new Error(`formato de A2S_INFO desconocido (0x${tipo.toString(16)})`);

  // Formato Source: protocolo, nombre, mapa, carpeta, juego, appid, jugadores, max, bots, tipoServer, ...
  const protocolo = lector.byte();
  const nombre = lector.cadena();
  const mapa = lector.cadena();
  lector.cadena(); // carpeta
  lector.cadena(); // juego
  lector.corto(); // appid
  const jugadores = lector.byte();
  const maximo = lector.byte();
  const bots = lector.byte();
  lector.byte(); // tipoServer ('d' dedicado, etc.)
  lector.byte(); // entorno ('w' windows, 'l' linux)
  lector.byte(); // visibilidad (0 público, 1 con contraseña)
  const vacante = lector.byte(); // 0 = libre, 1 = requiere VAC
  return { nombre, mapa, jugadores, maximo, protocolo, vacante, bot: bots };
}

// A2S_PLAYER: pide la lista de jugadores. En CS 1.6 suele aceptar el desafío 0xFFFFFFFF sin desafío real.
async function jugadoresServer(host, puerto, opciones = {}) {
  const timeout = opciones.timeoutMs ?? 3000;
  const paqueteBase = Buffer.alloc(5);
  paqueteBase.writeInt32LE(MAGIC, 0);
  paqueteBase.writeUInt8(A2S_PLAYER_CHALLENGE, 4);

  const pedirCon = (desafio) => {
    const paquete = Buffer.concat([paqueteBase, desafio ?? Buffer.alloc(0)]);
    return udpConsulta(host, puerto, paquete, timeout);
  };

  let res = await pedirCon(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  let cuerpo = leerRespuesta([res.msg]);
  let lector = crearLector(cuerpo);
  let tipo = lector.byte();

  if (tipo === 0x41) {
    const desafio = cuerpo.subarray(1, 5);
    res = await pedirCon(desafio);
    cuerpo = leerRespuesta([res.msg]);
    lector = crearLector(cuerpo);
    tipo = lector.byte();
  }

  if (tipo !== A2S_PLAYER_RESPONSE) throw new Error(`formato de A2S_PLAYER desconocido (0x${tipo.toString(16)})`);

  const cantidad = lector.byte();
  const jugadores = [];
  for (let i = 0; i < cantidad; i++) {
    lector.byte(); // índice
    const nombre = lector.cadena();
    const puntaje = lector.entero();
    lector.flotante(); // duración de conexión
    jugadores.push({ nombre, puntaje });
  }
  return jugadores;
}

// Consulta completa: info + jugadores (tolerante: si falla la lista, devuelve lo que pueda).
async function estadoServer(host, puerto, opciones = {}) {
  const info = await infoServer(host, puerto, opciones);
  let jugadores = [];
  try {
    jugadores = await jugadoresServer(host, puerto, opciones);
  } catch {
    // Algunos servers bloquean A2S_PLAYER con challenge inválido: la info ya es suficiente.
  }
  return { ...info, lista: jugadores };
}

module.exports = { consultar: estadoServer, info: infoServer, jugadores: jugadoresServer, crearLector, leerRespuesta };
