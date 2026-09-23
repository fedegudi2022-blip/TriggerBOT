# Conectarse a los servidores CS 1.6

## Cómo entro a un servidor
1. Pedí la IP con `/ip` (te muestra todas) o mirá el panel de `/servidores`.
2. Abrí Counter-Strike 1.6.
3. Abrí la consola con la tecla `~` y escribí `connect IP`, por ejemplo
   `connect cs.triggerarena.pro:27015`.
4. También podés usar el botón/opción de copiar la IP desde el mensaje del bot y
   pegarla en la consola.

## Cómo veo qué servidor está más lleno
`/servidores` muestra en vivo el estado de cada servidor (🟢 online / 🔴 caído),
cuántos jugadores hay, el máximo y el mapa actual. `/ip` con el nombre del servidor
como filtro (por ejemplo `/ip servidor:publico`) muestra esa misma información
resumida junto a la IP.

## Qué significa cada modo
- **Público**: servidor abierto, se entra cuando quieras y se juega el mapa que esté.
- **KZ / Bhop**: mapas de saltos y habilidad, sin combate.
- **Mix**: partidas armadas y organizadas con equipos, se avisa por Discord.
- **Duelos / 1v1**: enfrentamientos individuales.

## El servidor me aparece caído
Si un servidor figura 🔴 caído, no es tu problema de conexión: el bot lo consulta
automáticamente cada 90 segundos y avisa al staff cuando cae o vuelve. Esperá unos
minutos y volvé a mirar `/servidores`; si sigue caído mucho tiempo, avisá por ticket.
