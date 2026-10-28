---
title: Exportación completa
summary: Un archivo ZIP con los datos y metadatos de su organización, con JSON y CSV de cada tabla, los archivos guardados y un manifiesto, y cómo leerlo.
section: operate
order: 13
---

La exportación completa es un archivo ZIP con todo lo que su organización guarda en XOS: cada tabla en JSON y en CSV, los archivos que subieron las personas y un manifiesto que lo enumera todo. Es la exportación que prometen los Términos del servicio al cancelar o cambiar de proveedor, y el Propietario puede descargarla en cualquier momento, en cualquier plan.

## Descárguela

1. En Atlas, abra **Configuración** y luego **Zona de peligro**. Solo el Propietario ve la descarga.
2. Elija **Descargar la exportación completa**. El archivo lleva datos restringidos, así que su sesión debe haber pasado un segundo factor. Si no lo ha hecho, Atlas se lo pide primero.
3. El navegador guarda `<org>-export-<fecha>.zip`, con el identificador de su organización y la fecha de hoy según el calendario de su organización.

Cada exportación queda registrada con su número de tablas, filas y archivos, que **Exportaciones realizadas** muestra en la misma página. Mientras una organización cancelada está en solo lectura, durante los 30 días posteriores a la cancelación, la descarga sigue disponible.

## Qué contiene el archivo

| Ruta                              | Contenido                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                   | La primera entrada: cada tabla y archivo incluidos, con sus conteos y hashes. Léalo primero.                                            |
| `records/<tabla>.json`            | Una tabla: un arreglo de filas, cada una un objeto con todas las columnas que usted puede leer, con los valores tal cual.               |
| `records/<tabla>.csv`             | Las mismas filas en CSV, con una fila de encabezados en el orden de columnas de la tabla.                                               |
| `files/attachments/<id>-<nombre>` | Un archivo guardado: el id de su versión y luego su nombre, con `_` en lugar de todo carácter que no sea letra, dígito, `.`, `_` o `-`. |

Las tablas son todas las tablas de su organización en el esquema `app`, leídas con el propio acceso del Propietario, un par de archivos por tabla. Las filas en la Papelera se incluyen, con `deleted_at` lleno. Las filas que solo una persona puede leer, como el progreso de los recorridos guiados de otro miembro o sus preferencias personales, no se incluyen.

El [diccionario de datos](dictionary:) describe cada tabla y columna: qué guarda, su tipo, si puede quedar vacía y la tabla a la que apunta.

## El manifiesto

`manifest.json` es un objeto JSON:

| Campo              | Contenido                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `format`           | Siempre `xos-org-export`.                                                                                     |
| `version`          | La versión del formato, `1`. Un cambio que rompa a un lector lleva una versión nueva.                         |
| `orgId`            | El id de su organización.                                                                                     |
| `orgSlug`          | El identificador de su organización en las URL.                                                               |
| `createdAt`        | Cuándo se generó la exportación, en UTC (ISO 8601).                                                           |
| `tables`           | Una entrada por tabla: `table`, `rows` (el número de filas), y `json` y `csv`, las rutas de sus dos archivos. |
| `files`            | Una entrada por archivo guardado: `path`, `bytes`, `sha256` (el hash guardado al subirlo, o null) y `source`. |
| `filesOmitted`     | Cuántos archivos guardados no están en el archivo ZIP (vea más abajo).                                        |
| `unreadableTables` | Las tablas que no se pudieron leer. Se enumeran aquí; nunca se omiten en silencio.                            |

La respuesta de la descarga lleva el SHA-256 de `manifest.json` en su encabezado `X-Export-Manifest-Sha256`, y XOS guarda el mismo hash en el registro de exportaciones ([`app.org_exports`](dictionary:app.org_exports)), para que pueda demostrar más tarde que un archivo es el que descargó.

## JSON y CSV

Los archivos JSON están en UTF-8, un arreglo por tabla, con sangría. Los valores son exactamente los guardados: el texto y los códigos como cadenas, los números como números, el dinero en unidades menores junto a su columna de moneda, las horas en UTC y un valor vacío como `null`, nunca cero.

Los archivos CSV siguen RFC 4180: UTF-8, una fila de encabezados, líneas que terminan en CRLF y los campos con coma, comillas o salto de línea entre comillas dobles. Un valor vacío es una celda vacía. Una columna `jsonb` o de arreglo lleva su texto JSON. Un texto que una hoja de cálculo ejecutaría como fórmula (uno que empieza con `=`, `+`, `-` o `@`) lleva un apóstrofo delante; el archivo JSON lo conserva exactamente.

## Archivos

El archivo ZIP incluye los archivos que las personas subieron a los registros, que pasaron el análisis de carga y no están eliminados, en el orden en que se agregaron, hasta 500 archivos y 500 MB en total, para que un solo archivo se pueda descargar. `filesOmitted` cuenta los archivos que pasan de ese límite y los que no se pudieron leer; las filas de `records/attachment_versions.json` siguen describiéndolos todos. Si cambia de proveedor, pida los archivos omitidos como parte del soporte de transición (vea [Cambio de proveedor](guide:switching)).

## PDF generados

Las órdenes de compra, facturas, órdenes de cambio, hojas del día, hojas de llamado, guiones del evento, BEO, credenciales, informes de inspección y de incidentes, informes de costo final y certificados de acuerdo se generan a partir de sus registros cada vez que se abren, como PDF/UA-1 etiquetado. El archivo ZIP lleva los registros con los que se construyen. Un PDF que alguien subió es un archivo guardado y está en `files/`. Para conservar un documento generado como PDF, abra su registro en Atlas y descárguelo; también funciona mientras una organización cancelada está en solo lectura.

## Lo que no incluye

- **Columnas que nadie lee directamente**, como los números completos de cuenta bancaria, los importes de pago y los hashes de tokens o PIN. Se guardan detrás de sus propias vías de acceso y quedan fuera de los archivos de la tabla; el encabezado del CSV muestra exactamente qué columnas tiene cada tabla.
- **Datos de la plataforma** que no son de su organización, como los planes y las plantillas de la Biblioteca estándar. Las copias propias de su organización de los documentos y procedimientos de la Biblioteca estándar sí se incluyen.
- **La presencia y otros estados en vivo**, que XOS nunca guarda.

Para una copia nocturna en su propio bucket en lugar de una descarga, vea [Entrega al almacén de datos](guide:warehouse-delivery). Para leer registros uno a uno o por páginas, use la [referencia de la API](reference:projects).
