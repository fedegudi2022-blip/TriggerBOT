// Carga única de comandos slash: la usan el runtime (index.js) y el registro
// manual (deploy-commands.js / npm run register). Así ambos registran EXACTAMENTE
// lo mismo: 35 comandos directos + 8 generados (/beso, /abrazo...) + /moneda.
const fs = require('node:fs');
const path = require('node:path');

function cargarComandos() {
  const comandos = [];

  // 1) Comandos directos de src/commands/*.
  const commandsPath = path.join(__dirname, 'commands');
  for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
    const comando = require(path.join(commandsPath, file));
    if ('data' in comando && 'execute' in comando) {
      comandos.push(comando);
    } else {
      console.warn(`[AVISO] El comando "${file}" no tiene "data" o "execute" y se ignoró.`);
    }
  }

  // 2) Comandos generados por fábrica: /beso, /abrazo, /caricia, etc.
  const { comandos: generados } = require('./utils/fabricaInteracciones');
  comandos.push(...generados);

  // 3) /moneda vive junto a /dado pero se registra como comando propio.
  comandos.push(require('./commands/diversion').moneda);

  return comandos;
}

module.exports = { cargarComandos };
