// Indicador de "está escribiendo…" que aguanta turnos largos.
//
// Discord apaga el indicador a los ~10 s de mandarlo. El bot lo mandaba UNA vez al
// empezar a pensar y, cuando la respuesta tardaba más (búsqueda web + reintento por
// truncado + segundo proveedor), el usuario se quedaba mirando un canal sin ninguna
// señal de vida. Este helper lo refresca mientras dura el turno y lo corta al terminar.
//
// Nunca puede romper la respuesta: cualquier fallo de Discord se ignora en silencio.
const INTERVALO_POR_DEFECTO_MS = 8_000;

function mantenerEscribiendo(canal, { intervalo = INTERVALO_POR_DEFECTO_MS } = {}) {
  if (!canal?.sendTyping) return () => {};

  const enviar = () => {
    try {
      Promise.resolve(canal.sendTyping()).catch(() => {});
    } catch {
      /* canal borrado o sin permiso: el mensaje final sigue su curso */
    }
  };

  enviar();
  const timer = setInterval(enviar, intervalo);
  // El timer no puede mantener vivo el proceso (apagado controlado, tests).
  timer.unref?.();

  let activo = true;
  return function detener() {
    if (!activo) return;
    activo = false;
    clearInterval(timer);
  };
}

module.exports = { mantenerEscribiendo, INTERVALO_POR_DEFECTO_MS };
