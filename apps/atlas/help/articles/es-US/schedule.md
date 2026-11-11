---
title: Cronograma
summary: Planifique registros en la línea de tiempo con dependencias, siga los hitos y fije líneas base para ver cada retraso.
kind: page
nodes:
  [
    schedule.timeline,
    schedule.calendar,
    schedule.milestones,
    schedule.baselines,
    project.schedule,
    schedule,
    schedule.events,
    schedule.days,
    schedule.workload,
    schedule.clashes,
  ]
order: 20
---

## Línea de tiempo

Muestra los registros con fechas de inicio y fin como barras, con sus dependencias. Un registro que se mueve empuja a los que dependen de él, y cada cambio se registra como una replanificación con su motivo.

## Calendario

Muestra los mismos registros por día, semana o mes, con una lista de agenda para el teclado y los lectores de pantalla.

## Hitos

Los hitos son las fechas con las que se mide el proyecto. Aparecen en la línea de tiempo y en la preparación de compuertas.

## Líneas base

Una línea base congela el plan en un momento dado. Compare el plan actual con cualquier línea base para ver qué registros se retrasaron y cuánto.

## Días

Programación, Días indica para qué es cada día del proyecto: **Montaje**, **Función**, **Desmontaje**, **Viaje**, **Día libre**, **Ensayo** u **Otro**. Cada día se lee como texto con un icono junto a su color, en la línea de tiempo, el calendario, la hoja del día, Personal, Turnos y la línea de tiempo de la cartera.

- Elija **Agregar día**, o abra un día, para fijar su tipo, una etiqueta, dónde ocurre (una sede, una de las funciones del proyecto o un lugar escrito), su zona horaria y su equipo.
- **Dividir el día** agrega una parte, hasta cuatro, como un desmontaje por la mañana y el viaje a la siguiente ciudad por la tarde. Una parte en una sede se lee en la zona horaria de la sede.
- Quitar una parte la mueve a la Papelera; **Deshacer** la recupera.

## Editar un día como cuadrícula

Abra un día y elija **Editar como cuadrícula** para escribir sus registros como en una hoja de cálculo: Hora, Título, Tipo, Responsable y Por confirmar. Tab y Mayús+Tab se mueven entre celdas, Intro guarda una celda y baja, y escribir en la última fila agrega un registro.

- La hora acepta formas cortas en el reloj del proyecto: 8 a. m., 8:30 p. m., 20 h, 20:30, mediodía o un rango como 8a-10:30a. Un final antes del inicio es el día siguiente. También funcionan frases como "mañana 9am".
- **Guardar** muestra cuántos registros son nuevos, cambiados y rechazados, con cada rechazo en su celda. **Aplicar** escribe todas las filas o ninguna.

## Plantillas de día

Guarde los registros y cues de un día como plantilla con **Guardar el día como plantilla**; las horas se guardan desde la medianoche local. En otro día, **Aplicar plantilla de día** pone la plantilla junto a lo que el día ya tiene, por hora: los elementos nuevos llevan **Nuevo**, los que ya están en el día llevan **Ya está en este día** y quedan desmarcados, y se cuentan las superposiciones. Desmarque lo que no quiera y aplique; **Deshacer** mueve lo agregado a la Papelera. Las plantillas se listan y editan en Proyectos, Plantillas.

## El ancla

La pestaña Cronograma del proyecto muestra el **Ancla**, el día desde el que cuenta el plan, normalmente el día de la función. La línea de tiempo lo marca, y su tabla muestra el desfase de cada registro, como D−3 para tres días antes.

- **Fijar el ancla** fija la primera ancla; no mueve nada.
- **Mover el ancla** muestra qué se mueve y qué se queda: los registros con fecha se mueven días enteros en el reloj del proyecto, junto con los órdenes de presentación, los cues, los tipos de día y las hojas sin publicar. Los registros fijados a sus fechas, completos o bloqueados en una línea base se quedan, las hojas publicadas se quedan y los turnos nunca se mueven: reprograme a las personas contratadas en Personal, Turnos. **Volver a mover** en el aviso devuelve el plan.
- En un registro, **Se queda en sus fechas cuando se mueve el ancla** lo fija.

## Carga de trabajo

Programación, Carga de trabajo muestra las horas por persona y día de una semana, de turnos y tareas estimadas, como mapa de calor o tabla. Cada celda muestra sus horas como texto; un día sobre el límite de la organización (10 horas salvo que se cambie en Configuración, Programación) muestra **Más de 10 h** con un icono. Un turno que pasa la medianoche cuenta en cada día en su propia zona horaria. Abra una celda para ver sus horas de turnos, horas de tareas y tareas sin estimación.

## Conflictos

Programación, Conflictos lista personas en dos turnos a la vez, turnos durante el viaje de una persona, proveedores en dos producciones en sedes distintas, artistas en dos escenarios, cambios cortos, viajes demasiado cerca de una llamada y órdenes de presentación después de la hora límite. Cada uno es un **Conflicto** o una **Advertencia**, dice qué choca y enlaza a donde se corrige; nada se corrige por usted. Una hora por confirmar baja un conflicto a advertencia. Solo ve un conflicto cuando puede leer ambos lados.

Los responsables de hospitalidad también pueden elegir **Revisar solicitudes de viaje** para comparar las fechas de viaje solicitadas con las llamadas de cada persona. Cada revisión queda registrada en el registro de acceso de la persona.

Relacionado: [Trabajo](help:work), [Vistas guardadas](help:saved-views).
