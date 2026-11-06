---
title: Importación, Papelera y objetos personalizados
summary: Traiga registros desde una hoja de cálculo, restaure elementos eliminados y trabaje con los tipos de registro propios de su organización.
kind: page
nodes: [import, trash, custom-object]
order: 38
---

## Importación

1. Suba una hoja de cálculo y elija en qué se importa.
2. Confirme cómo se asocian sus columnas.
3. Revise los problemas y los posibles duplicados, y confirme.

Puede deshacer el lote completo durante 7 días.

En lugar de un archivo puede pegar filas copiadas de Excel, Google Sheets o Shoflo, con la fila de encabezados primero. Una vista previa muestra las primeras filas tal como se leerán. Mientras asocia las columnas, cada una muestra sus primeros valores y una vista previa ordena las primeras filas según sus opciones.

## Importar una escaleta

Abra una escaleta y elija Importar cues, o elija Cues de la escaleta en la página de importación y seleccione la escaleta. Las filas se convierten en cues de esa escaleta solamente.

- Un número de cue como 12, Q12 o CUE-07 fija la posición del cue. Las fracciones como 12.5 se rechazan.
- Las filas sin número de cue se agregan después del cue más alto, en el orden de la hoja, una vez que entran las filas numeradas.
- Las horas como 19:30 o 7:30 PM se leen en la fecha del show, en la zona horaria del proyecto. Las duraciones van en minutos, m:ss o h:mm:ss.
- Importar la misma escaleta otra vez actualiza los cues que coinciden, por número de cue o, sin él, por cue y hora. Nunca los agrega dos veces y nunca cambia un cue que ya se dio.
- Dos filas con el mismo número de cue en una hoja se rechazan como repetidas.

## Importar una lista de invitados

Abra la lista de invitados de un proyecto y elija Importar invitados, o elija Lista de invitados en la página de importación y seleccione el proyecto.

- Cada invitado importado se agrega como Solicitado. Una importación nunca aprueba, rechaza ni registra la llegada de un invitado.
- Un invitado que ya está en la lista con el mismo nombre para el mismo show se actualiza en lugar de agregarse. Un nombre parecido, o el mismo nombre para otro show, espera su decisión: combinarlo con el invitado de la lista o mantenerlos separados. Nada se combina solo.
- Una combinación conserva el nombre y el show del invitado.
- Ni la persona que subió la lista ni la persona que la confirmó pueden aprobar o rechazar esos invitados. Los decide otro revisor.

Deshacer quita los cues e invitados que agregó el lote y restaura los que cambió, durante 7 días. Un cue dado, o un invitado decidido o registrado después de la importación, se conserva, y el lote indica por qué.

## Papelera

Los elementos eliminados permanecen en la Papelera hasta que termina su período de retención, cuando se eliminan definitivamente. Restaure un elemento para recuperarlo, junto con todo lo que se eliminó con él.

## Objetos personalizados

Un administrador define los objetos personalizados en la configuración. Cada uno tiene su propia lista de registros, con las mismas vistas, filtros y acceso por API que cualquier otra colección.
