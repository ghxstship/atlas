---
title: Guion del espectáculo, hojas del día y hojas de llamado
summary: Arme el orden de un espectáculo, ejecútelo en vivo con señales y publique hojas del día y de llamado.
kind: page
nodes: [show.run-of-show, show.day-sheets, show.call-sheets, show.show-day, show.segments, project.show, show]
order: 22
---

## Guion del espectáculo

Es la lista ordenada de segmentos y señales de un espectáculo. Prepárela con anticipación y ejecútela en vivo: la señal actual avanza en tiempo real para todos, en Atlas y en Compass.

### Arme el orden

- Agregue cada señal con su hora planificada y su duración. Cuando una hora todavía es una estimación, marque **Hora por confirmar**: Atlas muestra **Por confirmar · aprox.** con la estimación, Compass, Gateway y el PDF muestran **Por confirmar**, y las suscripciones de calendario la marcan como provisional. Los registros ofrecen la misma casilla, **Hora de inicio por confirmar**, junto a **Inicio**.
- Elija el lápiz de una señal para editarla en su lugar: nombre, hora, duración y una llamada por departamento (Audio, Iluminación, Video, Efectos especiales y Escenario). **Esc** cancela.
- Use las flechas para mover una señal un lugar, o **Mover a la posición…** para ponerla en cualquier lugar después de la última señal llamada en un solo paso. Las señales llamadas conservan su lugar, y las señales se numeran de nuevo 1, 2, 3 después de mover una.
- Elija un **Departamento** para ver solo sus llamadas. Las señales que tienen una quedan marcadas; las demás indican que no hay llamada. La elección queda en la dirección de la página, así que puede compartirla.
- Fije una **Hora límite** en los detalles cuando el espectáculo tenga un final obligatorio.

### Llame el espectáculo

Elija **Ejecutar en vivo**. Si puede llamar señales, se abre la consola de llamado con el reloj del show, la hora del día, cuánto va atrasado o adelantado frente al plan y, cuando hay hora límite, el final proyectado frente a ella.

- **Llamar siguiente cue** llama la señal en espera o, si no hay, la siguiente. **Go** llama la señal seleccionada.
- **En espera** pone en espera la señal seleccionada; quienes siguen el show la ven en uno o dos segundos. **Cue anterior** y **Cue siguiente** mueven la espera, y **Saltar a un cue** elige cualquier señal sin llamar. Las señales que salte quedan marcadas como **Omitido**.
- **Ajustar −1 min** y **Ajustar +1 min** mueven todas las horas planificadas que quedan.

Con el foco en la consola, **J** y **K** mueven la espera, **S** pone en espera, **T** salta, **[** y **]** ajustan el plan y **D** cambia el departamento; **Espacio** en la lista de señales llama.

### Configure acciones Hotkey de Stream Deck con F13 a F20

Asigne a cada tecla del Stream Deck una acción **Hotkey**: **F13** Go, **F14** En espera, **F15** Cue anterior, **F16** Cue siguiente, **F17** Ajustar +1 min, **F18** Ajustar −1 min, **F19** Saltar a un cue y **F20** Departamento. Funcionan mientras la consola tiene el foco, aunque los atajos de una tecla estén desactivados, y puede cambiarlas en **Yo, Atajos de teclado**.

### Pantallas

Muestre el guion en cualquier televisor o laptop sin iniciar sesión. Abra el guion, elija **Pantallas**, elija el modo con el que abre la pantalla y cuándo vence el enlace (por defecto, al final del día siguiente al espectáculo), y copie el enlace y su código de acceso de 6 dígitos, que se muestran una sola vez. Necesita permiso para editar el guion.

- **Reloj de sala** muestra la hora local, la señal en curso y el tiempo que le queda.
- **Temporizador de presentador** cuenta hacia atrás la señal actual, o hacia adelante cuando no tiene duración.
- **Backstage** muestra la señal en curso, la siguiente con su hora prevista, las tres que siguen y si el espectáculo va atrasado.

Cuando una señal excede su duración, el temporizador se pone rojo y dice **Excedido por** el tiempo, hasta que se llama la siguiente señal. En la pantalla, las teclas 1, 2 y 3 cambian de modo, **Abrir en una ventana nueva** lleva la pantalla a un segundo monitor y **Pantalla completa** la llena. La pantalla sigue las señales a los pocos segundos de llamarse. Revoque el enlace para quitarlo de todas las pantallas.
### Editar el orden de presentación como cuadrícula

Elija **Editar como cuadrícula** para escribir los cues como en una hoja de cálculo: Hora, Duración, Etiqueta, Segmento y Por confirmar, en el orden de presentación. La hora acepta formas cortas como 8:30 p. m. o 20:30, y +1 marca un cue después de la medianoche; Duración acepta 45, 45m o 1h30. Escribir en la última fila agrega un cue, y **Subir** y **Bajar** reordenan. Los cues llamados, y los que van antes del último llamado, conservan su lugar. **Guardar** muestra la vista previa; **Aplicar** escribe todas las filas o ninguna y renumera los cues.

### Campos y colores de cues

Agregue sus propias columnas a los cues en **Configuración, Campos personalizados**: elija **Cues** como tabla y luego un tipo. Un campo de **Opción** puede dar a cada opción uno de siete colores; el nombre de la opción siempre se muestra junto a su color. Para cada campo de cue, elija para quién es: **Equipo** lo ve en Atlas, **Llamado del show** lo muestra en los enlaces de llamado y **Cliente** lo muestra en Gateway a un cliente contratado en el proyecto. Cada campo nuevo empieza con Equipo. Los campos de Persona, Dinero y Correo quedan con el equipo. Equipo es una elección de presentación: los miembros siguen viendo cada valor que su acceso permite.

El editor del cue tiene pestañas. **Cue** tiene la etiqueta, la hora, la duración, el **Segmento** y su **Color del segmento**, que colorea todo el segmento a la vez y sigue el segmento que escribe. **Palabras** tiene la **Descripción** y el **Guion hablado**, de hasta 20.000 caracteres. **Llamadas** tiene las cinco llamadas de departamento, y **Campos** sus campos de cue, cuando su organización tiene alguno. Lo que escribe se conserva al cambiar de pestaña, y un solo **Guardar** guarda el cue; **Campos** guarda por su cuenta. En vivo, el cue en curso muestra el color de su segmento y un **Guion hablado** que puede abrir.

### Biblioteca de segmentos

Guarde los bloques que usa en muchos shows, como una entrada de público, un bloque de premios o un momento de patrocinio, en **Show, Biblioteca de segmentos**: cada segmento tiene un nombre, un color, una descripción y cues con sus llamadas por departamento. Para usar uno, abra un guion y elija **Insertar segmento**: elija el segmento, dónde va (después del último cue llamado) y, si quiere, la hora en que empieza. Las copias son suyas para editar en ese guion.

Cuando cambia un segmento de la biblioteca, muestra **Biblioteca actualizada**. Elija **Publicar en shows** y marque las órdenes de show que actualizar, como máximo 50 a la vez; las desactualizadas ya están marcadas. En cada una, los cues no llamados del segmento se reemplazan por la versión actual, y se pierden los cambios locales a esos cues, incluidos sus valores de campos personalizados. Los shows donde se llamó un cue del segmento (**Tiene cues llamados**) o uno es el horario de un artista (**Tiene horarios de artistas**) quedan como están. El segmento muestra lo que pasó en cada una después de publicar.

### Canal del show

En vivo, el canal del show está junto al cue en curso: el chat del equipo del proyecto, donde nunca están los clientes. Elija **Abrir el canal del show** la primera vez (necesita permiso para editar el guion) y los miembros del proyecto se unen; los demás eligen **Unirse al canal del show**. Los mensajes nuevos aparecen al enviarse, y **M** lleva al cuadro de mensaje desde la consola.

### Enlaces de llamado del show

Permita que alguien sin cuenta de XOS llame el show. Abra el guion, elija **Enlaces de llamado del show**, nombre a quien llama, elija cuándo vence el enlace (por defecto al final del día después del show, como máximo 14 días) y copie el enlace y su código de acceso de 6 dígitos, que se muestran una sola vez. Necesita permiso para editar el guion y para llamar cues.

Cualquiera con el enlace y el código puede llamar cues y editar este guion hasta que venza: llamar, poner en espera, ajustar, mover, agregar, editar y quitar cues no llamados, y cambiar las llamadas por departamento. Nunca llega a otro guion. Un cue que llame dice **Llamado por** su nombre **con un enlace de llamado del show**. Un enlace funciona en hasta 5 dispositivos; **Cerrar sesión de dispositivos** hace que cada dispositivo ingrese el código otra vez, **Regenerar** da un enlace y código nuevos, y **Revocar** lo detiene para siempre. En el enlace, **Abrir reloj** abre un reloj de sala y un temporizador de presentador.

## Hojas del día

Una hoja del día resume una jornada del proyecto: horarios, lugares, contactos y notas. Publíquela cuando esté lista; las personas ven la última versión publicada.

El PDF de la hoja del día muestra las notas del día, sus llamados, sus reuniones, hitos y plazos, y los cues de esa fecha de show. **Descargar para…** imprime una copia para un equipo o un departamento: solo sus llamados y los registros asignados a ellos, de su propiedad o bajo su responsabilidad, nunca más de lo que usted puede ver. Elija un departamento del show para dejar solo los cues con un llamado de ese departamento, y elija carta o A4.

### Libros

Un libro imprime los documentos del show de un proyecto en un solo PDF con portada y contenido. Abra la pestaña **Documentos** del proyecto y elija **Nuevo libro**:

- Un **libro de gira** cubre días de show con fecha: hojas del día, hojas de llamado, guiones, órdenes de evento de banquete, inspecciones e incidentes, por día.
- Un **libro de producción** cubre todo el proyecto o un período y también puede contener el informe de costo final y el informe de cierre.

Las hojas del día y de llamado entran una vez publicadas, y se omiten los registros que usted no puede abrir; la portada dice cuántos. Un libro contiene hasta 100 documentos: acote sus fechas para descargar uno más largo. Eliminar un libro lo mueve a la papelera, y **Deshacer** lo recupera.

## Hojas de llamado

Una hoja de llamado indica a cada persona cuándo y dónde presentarse. Se basa en el horario del equipo, así que los cambios de turnos aparecen en la siguiente versión publicada.

## Contactos locales

Una hoja del día muestra los contactos locales de ese día: los del recinto, los del proyecto para todos los días y los de ese día. Agregue un miembro de la organización, cuyo nombre actual y teléfono de trabajo del directorio siempre se muestran, o escriba un contacto con teléfono y correo comerciales. Los contactos compartidos también llegan a las personas contratadas o en la lista del proyecto en Gateway y Compass; el teléfono de trabajo de un miembro nunca sale de la organización. Administre los contactos de un recinto desde su vista previa en Lugares > Recintos.

## Día del show

El día del show reúne en una página el día de show de un proyecto. Elija el proyecto y el día, o avance o retroceda un día. **Presentaciones por escenario** muestra la presentación de cada artista con su hora y duración, lo que ya se llamó y lo que sigue. **Órdenes de show** muestra cuántos cues llamó cada orden de show y el siguiente. **Llegadas** muestra quién llega ese día, en la zona horaria de su llegada, y **Hoteles** quién duerme dónde esa noche y quién entra o sale; ambos requieren acceso a hospitalidad. Lo que cambió desde su última visita lleva una etiqueta que dice qué cambió, y **Marcar todo como visto** quita las etiquetas. La página se actualiza en vivo a medida que se llaman los cues. Desde la pestaña Show de un proyecto, **Abrir día del show** abre el de hoy.
