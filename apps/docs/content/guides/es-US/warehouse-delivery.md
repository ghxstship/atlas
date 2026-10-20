---
title: Entrega al almacén de datos
summary: Archivos Parquet o CSV de los datos de su organización cada noche en su propio bucket, con el esquema publicado y lo que nunca se entrega.
section: operate
order: 12
---

La entrega al almacén de datos deja cada noche una copia de los datos de su organización en un bucket suyo, para que su almacén de datos la cargue. Es parte del plan Enterprise. XOS escribe archivos; nunca entrega credenciales de la base de datos.

## Configuración

1. En Atlas, abra **Configuración**, luego **Integraciones** y luego **Entrega al almacén de datos**. Necesita la capacidad **Programar la entrega de informes y al almacén de datos**.
2. Agregue un destino: el bucket, su región, una carpeta, el formato (Parquet o CSV) y la hora de la entrega nocturna (UTC).
3. Guarde la credencial del bucket. Se conserva en Vault y no se vuelve a mostrar.
4. Elija **Entregar ahora** para probarla, o espere a la noche.

Hoy funcionan S3 y cualquier servicio compatible con S3: Amazon S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2 y Google Cloud Storage mediante su punto de acceso de interoperabilidad. Para un servicio que no sea Amazon S3, indique su punto de acceso HTTPS. Se rechazan las direcciones privadas e internas. Los destinos nativos de Google Cloud Storage, Azure Blob, BigQuery y Snowflake aún no están disponibles.

La credencial es un JSON con una clave de acceso que solo pueda escribir en el bucket y la carpeta:

```json
{ "access_key_id": "<id de la clave de acceso>", "secret_access_key": "<clave de acceso secreta>" }
```

Agregue `"session_token"` para credenciales temporales.

## Qué llega

Cada entrega escribe una carpeta, `<carpeta>/<fecha>/<id de la entrega>/`:

| Archivo           | Contenido                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `<tabla>.parquet` | Una tabla. Una tabla de más de 50,000 filas llega en partes: `<tabla>.part-0001.parquet`, y así.         |
| `_schema.json`    | El esquema de esta entrega: cada tabla, sus columnas y tipos, y las columnas omitidas, con el motivo.    |
| `_manifest.json`  | Se escribe al final: cada archivo con sus filas, bytes y SHA-256. Cargue una entrega solo cuando exista. |

Las filas son las filas vigentes de su organización creadas antes de que empezara la entrega. Las filas eliminadas no se entregan. Cada archivo está completo por sí mismo; una entrega nueva no reemplaza nada anterior.

Los archivos Parquet tienen un solo grupo de filas, sin compresión, y todas las columnas admiten nulos. Tipos:

| Tipo del esquema | Tipo Parquet                           |
| ---------------- | -------------------------------------- |
| `string`         | BYTE_ARRAY, UTF8                       |
| `int32`          | INT32                                  |
| `int64`          | INT64                                  |
| `double`         | DOUBLE                                 |
| `boolean`        | BOOLEAN                                |
| `date`           | INT32, DATE                            |
| `timestamp`      | INT64, TIMESTAMP en UTC, microsegundos |

Los archivos CSV tienen una fila de encabezados, entrecomillan los campos según RFC 4180 y anteponen un apóstrofo a un valor que una hoja de cálculo ejecutaría como fórmula.

## Tablas

`projects`, `records`, `venues`, `counterparties`, `vendors`, `budget_lines`, `purchase_orders`, `po_lines`, `change_orders`, `invoices`, `payments`, `expenses`, `shipments`, `asset_units`, `shifts`, `timesheets`, `incidents`, `engagements` y `pay_rates`. Las columnas de cada una son las de la tabla del mismo nombre en la referencia de la API; la página de configuración y cada `_schema.json` las enumeran exactamente.

## Lo que nunca se entrega

- **Columnas restringidas**, como tarifas de pago, datos bancarios, identificadores fiscales, identificadores oficiales y notas médicas. Exportar datos restringidos exige autenticación reforzada cada vez, algo que una entrega nocturna no puede dar.
- **Columnas confidenciales**, salvo que alguien con la capacidad de exportación confidencial las active para el destino.
- **Valores cifrados**, que solo salen de XOS por sus propias pantallas.

Cada entrega queda en el registro de auditoría, con los archivos que escribió y el número de columnas que omitió.
