# Base de conocimiento de la IA

Los archivos `.md` de esta carpeta son lo que el bot **usa como verdad** cuando
alguien le pregunta algo por chat (mencionándolo). La IA lee estos archivos, busca
los fragmentos más parecidos a la pregunta y responde **solo con eso**: si la
respuesta no está acá, dice que no tiene esa información y deriva al staff.

> Este `README.md` **no** se usa como conocimiento (se ignora a propósito): las
> instrucciones de carga viven acá, no en las respuestas.

## Cómo se lee cada archivo

- Cada `## Título` abre una **sección** independiente; el texto hasta el próximo
  `##` es el contenido de esa sección.
- El buscador puntúa secciones por coincidencia de palabras (con raíces: `banear`
  encuentra `baneo`) y devuelve las 3 mejores, hasta 1.200 caracteres cada una.
- Los archivos que empiezan con `_` o se llaman `README.md` se ignoran.
- Los cambios en estos archivos se recargan solos como máximo **1 minuto** después
  de guardarlos: no hay que reiniciar el bot.

## Reglas de escritura

1. **Datos concretos, sin adornos.** "El silencio por 3 advertencias dura 1 hora"
   es útil; "acá te explicamos nuestra filosofía de moderación" no lo es.
2. **Una idea por sección**, con el título ya describiendo el tema
   (`## Cuánto XP necesito para subir de nivel`), porque el título también puntúa.
3. **Escribí el nombre del tema tal como lo preguntaría la gente**: "cómo entro al
   servidor", "cómo funciona el mute", "puedo publicar mi discord".
4. **Nunca inventes**: si no sabés el dato real, dejá la sección marcada como
   pendiente. El bot está instruido para decir "no tengo esa info" cuando no la
   encuentra, y eso es mejor que una respuesta falsa.

## Archivos actuales

| Archivo | Qué cubre |
|---|---|
| `comunidad.md` | Qué es TriGGer.Arena, links oficiales, redes, web |
| `conectar.md` | Cómo entrar a los servidores CS 1.6, IPs, filtros |
| `niveles.md` | XP, niveles, racha, bonus, rangos y logros |
| `moderacion.md` | Warn, timeout, mute, clear, lockdown y sanciones automáticas |
| `soporte.md` | Tickets, cómo pedir ayuda y reportar a alguien |
| `reglas.md` | Normativas oficiales: las 12 normas de TriGGer.Arena |
| `bot.md` | Qué es el bot, cómo hablarle y qué comandos tiene |
