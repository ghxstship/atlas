---
title: Finanzas
summary: Presupuestos, gastos, órdenes de cambio, facturas y pagos, y la contabilidad que los respalda.
kind: page
nodes: [finance, "finance.*", project.budget]
order: 30
---

Finanzas registra lo que se espera que cueste un proyecto, lo que compromete y lo que paga.

## Presupuestos

Cree un presupuesto desde el catálogo en el nivel Base, Elevado o Premium. Una línea sin precio muestra **Sin precio** y nunca cuenta como cero; los totales indican cuántas líneas siguen sin precio. Un proyecto en otra moneda muestra los totales convertidos con la fecha del tipo de cambio.

Los precios al cliente están junto al costo. Define un **Recargo predeterminado %** en el presupuesto o un **Recargo %** en una línea, o escribe un **Precio unitario al cliente** para reemplazar ambos; al borrarlo vuelve al recargo. Una línea sin precio de costo y sin precio escrito no tiene precio al cliente y muestra **Sin precio**. **Líneas de la cotización** elige qué líneas van en las cotizaciones; las demás son internas. Cambia la cuadrícula entre **Costo**, **Precios al cliente** y **Pronóstico**.

## Versiones

**Versiones** congela el plan del presupuesto con **Tomar una instantánea**, y **Comparar** muestra lo agregado, eliminado y cambiado frente al presupuesto actual u otra versión, con diferencias que quedan en blanco cuando alguno de los lados no tiene precio. Una versión no reemplaza la línea base de la compuerta 3. Las cotizaciones guardan sus propias capturas, que no se pueden eliminar.

## Pronóstico

Las columnas de **Pronóstico** muestran **Compromiso pendiente**, **Estimado para terminar** (escribe una cifra o déjalo en blanco para derivarla), **Costo final estimado** y **Variación al terminar**. Se derivan de Real, Comprometido y las órdenes de cambio aprobadas, así que cambian con cada gasto, aprobación y orden de compra. Si no puedes leer las órdenes de compra, los gastos o las órdenes de cambio del proyecto, las cifras quedan en blanco en lugar de parciales.

## Real y Movimientos

Real son los gastos aprobados y pagados más las horas aprobadas del equipo. Un turno indica la línea de mano de obra donde se registra su tiempo, y al aprobar una hoja de horas ese tiempo se registra con la tarifa vigente en cada fecha de trabajo. El tiempo sin tarifa se registra sin precio: aparece como **n horas sin precio** y nunca cuenta como cero. Selecciona una línea y elige **Movimientos** para ver qué hay detrás de Real y Comprometido. Las facturas de proveedores de la línea se muestran aparte: se registran en el libro mayor y cuentan en el informe de costo final, no en Real.

## Cotizaciones

**Cotizaciones** crea una cotización para el cliente a partir de un presupuesto. Un borrador usa los precios actuales, con costo y margen visibles solo para ti bajo **Interno: nunca aparece en la cotización**. **Enviar cotización** congela la versión y la huella de su contenido. Escribe un correo para obtener un enlace de firma y un código de acceso, que se muestran una sola vez, o déjalo en blanco y el cliente firma en la pestaña Documentos de Gateway. Enviar una versión nueva reemplaza la anterior. Cuando el cliente firma, la cotización queda aceptada y bloqueada; registra los cambios posteriores como una orden de cambio. Atlas nunca retiene fondos, así que una cotización no tiene estado de pago.

## Importar líneas

**Importar líneas** trae líneas de presupuesto desde .xlsx o .csv con el asistente de importación, con un motivo para cada celda que no pueda leer. Una fila con número de línea actualiza esa línea, y las demás se agregan en el orden de la hoja. Un precio en blanco o la palabra Unpriced queda sin precio. Deshacer quita las líneas que creó el lote, salvo que algo dependa de ellas desde entonces.

## Gastos y órdenes de cambio

Envíe un gasto con su recibo. Cree una orden de cambio cuando cambien el alcance o el costo. Una orden de cambio se puede guardar sin precio, y el presupuesto se actualiza cuando se le pone precio y se aprueba. Nadie aprueba su propia solicitud.

## Facturas y pagos

Las facturas de proveedores y a clientes se reúnen en **Facturas**. Las facturas aprobadas se convierten en pagos. Atlas registra cada pago; no mueve dinero.

## Contabilidad

- **Libro diario** y **Periodos**: registre asientos en un periodo abierto. Cuando un periodo está cerrado, se rechaza registrar en él.
- El **Catálogo de cuentas** viene del canon; asocie su libro mayor con él. Los **Centros de costos** son aquello sobre lo que informa.
- La **Exportación de la línea de registro universal** genera las líneas contables para su sistema de contabilidad.
- **Cierre del año** lista a los contratistas que alcanzaron el umbral del 1099-NEC y descarga el archivo para presentarlo. Los identificadores fiscales completos requieren una exportación Restringida con verificación adicional.
