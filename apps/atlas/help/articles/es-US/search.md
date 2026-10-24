---
title: Búsqueda
summary: Encuentre cualquier registro, persona, documento, configuración o página desde el menú de comandos, y acote una búsqueda con operadores.
kind: guide
nodes: ["*"]
order: 6
---

Pulse **Mod+K** o **/** en cualquier lugar de Atlas para abrir el menú de comandos. Antes de escribir, muestra lo que abrió por última vez (hasta 50 registros, incidentes, documentos, SOP y artículos del manual), las acciones comunes y los operadores de búsqueda. Todo funciona con el teclado: las flechas se mueven, **Enter** abre y **Esc** cierra.

## Qué encuentra la búsqueda

- Registros e incidentes, por título o por clave (escriba `NWS-12`).
- Personas de su organización, por nombre.
- Documentos, SOP y artículos del manual, por título y texto.
- Configuraciones, por nombre o clave: escriba `zona horaria` para llegar a la página de Localización con el campo listo para cambiar.
- Páginas, artículos de ayuda y acciones como **Nuevo registro** o **Aprobar hojas de horas**.

Solo verá lo que puede abrir. Cada palabra que escribe también coincide con el inicio de palabras más largas, así que `instal` encuentra "Install the stage deck".

## Operadores

Agregue operadores para acotar una búsqueda. Aparecen como etiquetas bajo el campo de búsqueda; el menú marca los que no entiende para que pueda corregirlos.

- `tipo:` un tipo de registro (`tipo:tarea`), o `persona`, `incidente`, `documento`, `sop` o `artículo`.
- `proyecto:` la clave de un proyecto o el inicio de su nombre (`proyecto:NWS`).
- `asignado:yo`, o parte del nombre de alguien (`asignado:ana`).
- `estado:` un estado (`estado:bloqueado`), o `abierto` o `cerrado`.
- `fase:`, `urid:` y `depto:` acotan los registros por fase, URID o departamento.
- `es:bloqueado`, `es:abierto`, `es:vencido` y `es:mío`.
- `antes:` y `después:` el día en que algo cambió por última vez: una fecha (`2026-10-01`), `hoy`, `ayer` o un número de días (`después:7d` es la última semana).
- `vence:` `hoy`, `vencido`, `<7d` (vence en una semana) o una fecha.

Escriba palabras entre comillas para encontrarlas juntas (`"load in"`) y ponga un signo menos antes de una palabra, una frase o un operador para excluirlo (`-strike`, `-estado:completo`). Las fechas siguen la zona horaria de su organización.

## Búsqueda por significado

Cuando un administrador activa **Búsqueda semántica** en Configuración, Funciones de IA, la búsqueda también encuentra documentos, SOP y artículos del manual que significan lo que escribió aunque usen otras palabras. Estos resultados dicen **Relacionado**. El texto se procesa con un modelo de embeddings dentro de la plataforma; no se envía nada a otro proveedor.
