---
title: Escrituras, idempotencia y concurrencia
summary: Crea con un Idempotency-Key, actualiza con If-Match, cambia ciclos de vida con transiciones de comparar y establecer, y elimina a la Papelera.
section: api
order: 4
---

Cada cambio en las aplicaciones tiene una operación equivalente en la API, y toda escritura sigue las mismas reglas, así que una solicitud repetida o concurrente nunca corrompe los datos.

## Claves de idempotencia

Todo POST requiere un encabezado `Idempotency-Key` de 8 a 255 caracteres. La API guarda cada clave por organización durante 24 horas:

- Una repetición con la misma clave y el mismo cuerpo devuelve la respuesta original, con `Idempotent-Replayed: true`.
- La misma clave con otro cuerpo devuelve 409.

Genera una clave por cada acción prevista y reutilízala en cada reintento de esa acción. Los SDK generan una clave para cada llamada y la reutilizan en sus propios reintentos. Pasa tu propia clave cuando un reintento puede venir de un proceso nuevo, por ejemplo un trabajo de importación que se reinicia:

```ts
await xos.projects.create(body, { idempotencyKey: `import-${fileHash}-${rowNumber}` });
```

`xos import` deriva una clave del archivo y de la fila, así que repetir una importación nunca crea una fila dos veces.

## ETag e If-Match

Las lecturas devuelven un `ETag`. Una actualización (PATCH) debe devolverlo como `If-Match`:

- Una etiqueta vigente aplica la actualización y devuelve el nuevo `ETag`.
- Una etiqueta desactualizada devuelve 412: alguien cambió la fila después de que la leíste. Léela otra vez, vuelve a aplicar tu cambio y reintenta.
- Si falta la etiqueta, devuelve 428.

```python
current = xos.projects.get(project_id)
xos.projects.update(project_id, {"name": "Harborfront Fall Series"}, if_match=current.etag)
```

PATCH cambia solo los campos que envías. Los campos omitidos quedan como están.

## Transiciones de ciclo de vida

Los estados nunca cambian con PATCH. Cada ciclo de vida avanza con `POST /{coleccion}/{id}/transitions`, con el estado en el que crees que está la fila y el estado que quieres:

```json
{
  "expected_state": "Proposed",
  "to_state": "Active",
  "reason": "Client approved the revised scope."
}
```

Si la fila ya no está en `expected_state`, o el cambio no está permitido, la API lo rechaza con 422 y explica por qué. Cada transición queda escrita en el registro de transiciones de la fila.

## Eliminaciones

DELETE mueve una fila a la Papelera, donde se puede restaurar durante el periodo de retención de su tabla.

## Dinero

El dinero se expresa en unidades menores enteras con una moneda: `1250` con `USD` son 12.50 dólares. `null` significa sin precio, nunca cero, y los totales incluyen `unpriced_count` para distinguir un cero real de precios faltantes.
