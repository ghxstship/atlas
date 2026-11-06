---
title: Equipo, tiempo y nómina
summary: Publique turnos, registre el tiempo desde Compass, apruebe hojas de horas y exporte la nómina.
kind: page
nodes:
  [
    crew,
    crew.schedule,
    crew.shifts,
    crew.swaps,
    crew.shortages,
    crew.positions,
    crew.time-entries,
    crew.timesheets,
    crew.rate-cards,
    crew.pay-periods,
    crew.payroll-exports,
    crew.time-off,
    crew.per-diems,
    crew.access-links,
    project.crew,
  ]
order: 51
---

## Turnos y horario

Los turnos se abren como un programa de recursos en Atlas, con personas a un lado y el tiempo a lo largo. Publique turnos para que el equipo los acepte en Compass. Los intercambios requieren aprobación.

XOS avisa a la persona de un turno publicado cuando se le asigna y cuando cambian sus horas. Otros cambios, como un rol nuevo, una cancelación o la vuelta a Borrador, no se anuncian, así que el turno muestra **Requiere revisión** con el número de cambios desde el aviso. La vista rápida del turno muestra cómo y cuándo se le avisó por última vez (por notificación, al aceptar el turno o con su marca) y qué cambió desde entonces. Después de avisarle, elija **Marcar como comunicado**; con **Revisión** en **Requiere revisión**, puede marcar todos los turnos de la lista a la vez.

Quien planifica puede crear un turno en borrador con una línea en el campo de agregar rápido, como "#tramoyista @dana ~NWS-S01 viernes 8am-4pm": `#` nombra el rol, `@` la persona (sin ella, el turno queda abierto), `~` el alcance y la fecha su llamada y su fin. Sin hora de fin, un turno dura ocho horas.

## Registros de tiempo y hojas de horas

El equipo marca entrada y salida en Compass, dentro de la geocerca de la sede. Una segunda entrada en otro dispositivo se rechaza. Si cambian las horas después de aprobar una hoja, la aprobación se anula.

## Tarifas y nómina

Las tarjetas de tarifas fijan el pago por rol y regla. Ejecute la exportación de nómina de un período, publíquela y el período se cierra. Un período cerrado no se puede reabrir. Las tarifas se ocultan a quienes no tienen acceso a nómina.

## Viáticos

Agregue viáticos en Equipo > Viáticos después de elegir un proyecto: elija a un miembro o a una persona contratada en el proyecto, el primer y el último día, y el monto diario. Cada día se registra una vez por persona, y el personal externo recibe viáticos solo mientras su contratación está Activa o En cierre. Quitar un viático conserva su historial.

## Faltantes

Crew > Faltantes muestra lo que aún no está cubierto entre dos días, en todos los proyectos que puedes leer: turnos abiertos, plazas de agencia que nadie de la lista ocupa, ofertas sin responder, preguntas de ¿Sigues yendo? sin responder o rechazadas, ausencias sin reemplazo y líneas de mano de obra sin acuse en órdenes de compra aprobadas o enviadas. Las filas van por día, en la zona horaria de cada turno, y cada una abre su turno u orden. Un rango puede tener hasta 62 días.

## Puestos

Crew > Puestos guarda plazas que se cubren después, como Jefe de escena o Aparejador 2. Reserva turnos para un puesto desde el formulario del turno y asígnale registros desde el registro. Nadie reclama ni se arrastra a un turno reservado. Cubrir el puesto da sus turnos a quien lo ocupa y muestra arriba de la página lo cubierto, omitido o con avisos. Dejarlo vacante devuelve los turnos que no han empezado y quita solo las asignaciones que hizo la cobertura. Se rechaza la solicitud de cambio de un turno reservado. Un turno nuevo en un puesto cubierto pasa a su titular.

## ¿Sigues yendo? y ausencias

Activa Ajustes > Programación > Preguntar al equipo si sigue yendo, y a quien trabaja un turno aceptado se le pregunta una vez antes de que empiece. Responde por correo, notificación, Inicio de Gateway o el propio turno hasta que empiece. Si alguien no puede ir, el turno se reabre o vuelve a su agencia, salvo que lo desactives. Marca la ausencia en un turno ya empezado cuando la persona no llegó ni registró su entrada. Un registro de entrada posterior la retira.

## Avisos de programación

El descanso mínimo y las horas máximas por día y por semana en Ajustes > Programación son avisos de tu organización, visibles en el tablero de programación, el registro del turno y la aprobación de cambios y reclamos. Nunca rechazan una asignación ni son reglas de pago o de horas extra estatales. Los minutos de un turno cuentan el día en que empieza, y la etiqueta semanal se refiere a la semana que empieza en el inicio de semana de tu nómina, que puede diferir de la semana ISO que usan las horas del tablero.

## Tipos de descanso

Ajustes > Tiempo y asistencia define los descansos, cada uno pagado o sin pagar. Un descanso pagado es tiempo trabajado, así que sus minutos no se restan de las horas y aparecen como Descanso pagado junto a Descanso. Compass pregunta qué descanso cuando hay dos o más tipos. Una organización sin tipos funciona como antes.

## Enlaces de acceso del equipo

Algunas personas del equipo nunca abren la app. Un enlace de acceso muestra a una persona sus propios turnos en un proyecto en Gateway, sin iniciar sesión, y le permite aceptar su propio turno publicado. Abre Enlaces de acceso del equipo, elige Emitir enlaces, elige el proyecto y las personas, y cuánto duran los enlaces, de 1 hora a 30 días.

Cada persona recibe un enlace y un código de 6 dígitos, que se muestran una sola vez. Cópialos o imprime una tarjeta ahora, porque no se vuelven a mostrar. Una tarjeta impresa lleva el código solo si marcas la casilla; déjala sin marcar para enviar el código por otra vía, así una tarjeta perdida no abre nada.

Un enlace se cierra cuando la persona deja de trabajar en el proyecto, cuando elimina su cuenta o cuando lo revocas. Cinco códigos incorrectos lo bloquean, y emitirlo de nuevo lo reemplaza. Un enlace no muestra tarifas, notas ni turnos de otras personas, y nadie puede registrar tiempo ni rechazar con él. Para estar en un turno, una persona debe haber aceptado algo una vez, como una membresía, una contratación o un lugar en el equipo.
