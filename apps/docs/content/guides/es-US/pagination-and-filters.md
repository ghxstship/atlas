---
title: Paginación y filtros
summary: Páginas por cursor, conjuntos de campos dispersos, la gramática de filtros y el orden, con el orden numérico que siempre mantienen las listas codificadas.
section: api
order: 3
---

Cada operación de lista devuelve una página, acepta los mismos parámetros de consulta y mantiene un orden predeterminado documentado.

## Páginas por cursor

Una página tiene `data` y `next_cursor`. Devuelve `next_cursor` como `cursor` para la página siguiente; es `null` en la última página.

| Parámetro | Significado                                                               |
| --------- | ------------------------------------------------------------------------- |
| `limit`   | Tamaño de página, de 1 a 200. El valor predeterminado es 50.              |
| `cursor`  | El `next_cursor` de la página anterior. Es opaco: nunca lo construyas tú. |

Los cursores siguen siendo correctos mientras se agregan filas, a diferencia de los desplazamientos. Los SDK recorren todas las páginas por ti:

```ts
for await (const record of xos.records.listAll({ filter: { record_state: { eq: "Blocked" } } })) {
  console.log(record.title);
}
```

```python
for record in xos.records.list_all(filter={"record_state": {"eq": "Blocked"}}):
    print(record["title"])
```

## Conjuntos de campos dispersos

`fields=id,title,record_state` devuelve solo esos campos de primer nivel. `id` siempre se devuelve. Las respuestas más pequeñas son más rápidas en listas grandes.

## Filtros

Los filtros usan `filter[campo][operador]=valor`. Las condiciones sobre campos distintos se combinan con Y.

| Operador                 | Coincide con                                   |
| ------------------------ | ---------------------------------------------- |
| `eq`, `ne`               | Igual, distinto                                |
| `lt`, `lte`, `gt`, `gte` | Menor que, como máximo, mayor que, como mínimo |
| `in`                     | Cualquiera de una lista separada por comas     |
| `is_null`                | `true` para vacío, `false` para definido       |
| `contains`               | Texto que contiene el valor                    |

```bash
curl -G "$XOS_BASE_URL/records" -H "Authorization: Bearer $XOS_API_KEY" \
  --data-urlencode "filter[record_state][eq]=Blocked" \
  --data-urlencode "filter[due_at][lte]=2026-11-01T00:00:00Z"
```

Con la CLI, escribe `--filter record_state.eq=Blocked --filter due_at.lte=2026-11-01T00:00:00Z`.

## Orden

`sort=starts_at,-updated_at` ordena por cada clave en turno; un `-` inicial ordena de forma descendente. Sin `sort`, cada lista usa el orden predeterminado indicado en su entrada de la referencia. Las listas codificadas, como departamentos, fases y cuentas contables, siempre se devuelven en orden numérico de código.

## Caché del canon

El canon solo cambia cuando se publica una nueva generación de canon, así que las lecturas de canon se pueden guardar en caché de forma permanente. Cada respuesta de `GET /canon/...` lleva `XOS-Canon-Generation`. Agrega `generation=<n>` a la misma solicitud y la respuesta se guarda en caché con `Cache-Control: private, max-age=31536000, immutable`: una URL con una generación siempre significa esa generación. Una solicitud de cualquier otra generación se redirige (307) a la misma URL con la generación actual, así una caché nunca sirve canon desactualizado. Sin `generation`, la respuesta se revalida en cada uso y `Content-Location` indica la URL que se puede guardar en caché.

```bash
curl -i -G "$XOS_BASE_URL/canon/departments" -H "Authorization: Bearer $XOS_API_KEY" \
  --data-urlencode "generation=1"
```
