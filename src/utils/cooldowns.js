// Cooldown por usuario y por comando. Lo aplica el handler de comandos de index.js.
//
// Por qué existe: no había ningún límite por usuario en los comandos, y varios salen a
// la red (Reddit en /meme, Wikipedia y DuckDuckGo en /buscar, A2S por UDP en
// /servidores, /ip y /jugadores). Un usuario apretando el mismo comando se comía la
// cuota de esas fuentes y castigaba a todos los demás.
//
// Cómo se configura: cada comando declara `cooldown: <segundos>` en su módulo. Sin
// declarar nada vale POR_DEFECTO_SEGUNDOS; con `cooldown: 0` el comando no tiene límite.
// Es anti-abuso, no anti-uso: los valores son chicos a propósito.
const POR_DEFECTO_SEGUNDOS = 2;

// Tope del registro de últimos usos: con 1 000 entradas alcanza para un servidor entero
// y el proceso nunca crece sin control.
const MAX_ENTRADAS = 1000;

const ultimos = new Map(); // "comando:usuario" → timestamp del último uso permitido

// Poda por orden de inserción (el Map lo conserva): las primeras claves son las más viejas.
function podar() {
  if (ultimos.size <= MAX_ENTRADAS) return;
  const sobran = ultimos.size - MAX_ENTRADAS / 2;
  let borradas = 0;
  for (const clave of ultimos.keys()) {
    ultimos.delete(clave);
    if (++borradas >= sobran) break;
  }
}

// ¿Puede usar el comando ahora? Devuelve null si sí (y registra el uso) o { restante }
// con los segundos que faltan si todavía no.
//
// El intento bloqueado NO renueva el reloj a propósito: si lo hiciera, spamear el
// comando sería la forma de dejarlo bloqueado para siempre.
function esperar(comando, userId, segundos = POR_DEFECTO_SEGUNDOS) {
  const ventanaMs = Math.max(Number(segundos) || 0, 0) * 1000;
  if (!ventanaMs) return null; // comando sin límite

  const ahora = Date.now();
  const clave = `${comando}:${userId}`;
  const transcurrido = ahora - (ultimos.get(clave) ?? 0);
  if (transcurrido < ventanaMs) return { restante: Math.ceil((ventanaMs - transcurrido) / 1000) };

  ultimos.set(clave, ahora);
  podar();
  return null;
}

// Aviso uniforme para el usuario. Texto plano: es un mensaje de trámite, no un embed.
function aviso(comando, restante) {
  return `Esperá ${restante} s para volver a usar \`/${comando}\`.`;
}

// Cuántas entradas hay registradas (lo usa el test de la poda).
function tamano() {
  return ultimos.size;
}

// Deja el registro como recién arrancado (tests).
function olvidar() {
  ultimos.clear();
}

module.exports = { POR_DEFECTO_SEGUNDOS, MAX_ENTRADAS, esperar, aviso, tamano, olvidar };
