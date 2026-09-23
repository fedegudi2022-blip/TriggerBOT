// Carga única de comandos slash: la usan el runtime (index.js) y el registro
// manual (deploy-commands.js / npm run register). Así ambos registran EXACTAMENTE
// lo mismo: 38 comandos directos + 8 generados (/beso, /abrazo...) + /moneda.
//
// Resiliencia: un módulo roto NO tumba el bot. Antes, un `setDescription()` con más
// de 100 caracteres en un solo archivo hacía que el `require()` lanzara durante el
// arranque y el proceso muriera entero — el bot quedaba offline, sin moderación ni
// tickets, por un error de tipeo. Ahora ese comando se saltea, se registra el motivo
// y el bot arranca con el resto (el fallo se ve en `/diag`).
const fs = require('node:fs');
const path = require('node:path');
const crearLogger = require('./logger');

const log = crearLogger('comandos');

// Fallos de la última carga: { archivo, motivo }. Los consume /diag y los tests.
let fallos = [];

function intentar(etiqueta, cargar) {
  try {
    return cargar();
  } catch (error) {
    fallos.push({ archivo: etiqueta, motivo: error.message });
    log.error(`No pude cargar ${etiqueta}: ${error.message}`);
    return null;
  }
}

function cargarComandos() {
  fallos = [];
  const comandos = [];

  // 1) Comandos directos de src/commands/*.
  const commandsPath = path.join(__dirname, 'commands');
  for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
    const comando = intentar(file, () => require(path.join(commandsPath, file)));
    if (!comando) continue;
    if ('data' in comando && 'execute' in comando) {
      comandos.push(comando);
    } else {
      // Un módulo que exporta un comando "extra" (como diversion.js con /moneda) no
      // necesita data/execute propios: se resuelve en el paso 3.
      if (!('moneda' in comando)) {
        fallos.push({ archivo: file, motivo: 'no exporta "data" ni "execute"' });
        log.warn(`El comando "${file}" no tiene "data" o "execute" y se ignoró.`);
      }
    }
  }

  // 2) Comandos generados por fábrica: /beso, /abrazo, /caricia, etc.
  const fabrica = intentar('utils/fabricaInteracciones.js', () => require('./utils/fabricaInteracciones'));
  if (fabrica?.comandos) comandos.push(...fabrica.comandos);

  // 3) /moneda vive junto a /dado pero se registra como comando propio.
  const moneda = intentar('commands/diversion.js (/moneda)', () => require('./commands/diversion').moneda);
  if (moneda) comandos.push(moneda);

  return comandos;
}

// Los fallos de la última carga (copia, para que nadie mutile el estado interno).
function fallosDeCarga() {
  return fallos.map((f) => ({ ...f }));
}

module.exports = { cargarComandos, fallosDeCarga };
