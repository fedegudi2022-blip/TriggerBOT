# Moderación y sanciones

## Cómo se modera
El staff usa comandos del bot: `/warn`, `/warnings`, `/quitarnota`, `/timeout`,
`/mute`, `/unmute`, `/kick`, `/ban`, `/unban`, `/softban`, `/clear`, `/lockdown` y
`/slowmode`. Todos requieren permisos de moderación o un rol de staff configurado en
`/config staff` (admin, mod o helper). Un miembro común **no puede** usarlos.

## Advertencias (warn)
`/warn` con una razón deja una advertencia en el historial del usuario. **Al llegar a
3 advertencias el usuario queda silenciado automáticamente durante 1 hora**. El
historial se consulta con `/warnings` y una advertencia puntual se borra con
`/quitarnota`.

## Silencio temporal (timeout) y mute
- `/timeout` silencia por un tiempo limitado (se elige duración); el límite de
  Discord es de hasta 28 días.
- `/mute` aplica el rol **Silenciado**, que es **indefinido**: dura hasta que el
  staff lo saque con `/unmute`.
- Que un timeout no te permita escribir es normal: es la sanción, no un error.

## Expulsión y baneo
- `/kick` expulsa al usuario del servidor (puede volver por invitación).
- `/ban` lo banea (no puede volver hasta que lo desbaneen); `/unban` revoca un baneo
  usando la ID del usuario. Un baneo puede ser permanente: banear o desbanear siempre
  lo decide el staff, y para preguntar por un ban (o pedir que lo revisen) hay que
  abrir un ticket de soporte.
- `/softban` borra los mensajes recientes y expulsa.

## Limpiar y bloquear canales (staff)
- `/clear` borra hasta **100** mensajes recientes del canal.
- `/lockdown` con la acción `bloquear` cierra el canal para que nadie escriba, y con
  `desbloquear` lo reabre.
- `/slowmode` pone un modo lento para que la gente no pueda escribir en ráfaga.

## Sanciones automáticas (anti-spam y anti-raid)
El bot tiene protección automática, pero **viene apagada hasta que el staff la
activa** en `/config → Anti-spam y anti-raid`. Cuando está activa:
- **Anti-spam**: si alguien manda una ráfaga de mensajes en pocos segundos (por
  defecto 5 mensajes en 5 segundos), el bot ejecuta la acción configurada sobre esa
  persona (avisar, silenciar, expulsar o banear) y alerta al staff.
- **Anti-raid**: si entran muchos miembros nuevos en poco tiempo (por defecto 8 en 60
  segundos), el bot siempre alerta al staff; si la auto-acción está activada, además
  expulsa o banea a los ingresos con cuenta recién creada (menos de 7 días).
Por eso, si alguien flodeó y lo silenciaron sin que nadie lo pida a mano, fue el
sistema automático.

## "Me sancionaron y no entiendo por qué"
Nadie te va a explicar la sanción por chat público: hay que abrir un ticket de
soporte con el botón 📨 del canal de tickets. El historial de advertencias queda
registrado con su motivo, así que el staff puede revisarlo.
