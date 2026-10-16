---
title: La CLI xos
summary: Inicia sesión, cambia de organización, llama a cualquier operación, importa y exporta filas, valida códigos del canon y prueba webhooks desde una terminal.
section: tools
order: 9
---

`xos` es la línea de comandos de la API pública. Cada operación de la referencia es un comando, y su salida es JSON en scripts y una tabla en una terminal.

## Inicia sesión

```bash
export XOS_API_KEY="xos_live_..."
xos auth login --base-url https://atlas.example.com/api/v1 --profile northwind
xos auth status
```

La clave se lee de `XOS_API_KEY` o se envía con `--key-stdin`, nunca se escribe como opción, así que no queda en el historial de la terminal. `xos` comprueba la clave y la guarda como perfil en `~/.config/xos/config.json`, que solo tú puedes leer.

## Elige una organización

Una clave de API pertenece a una organización, así que cada organización es un perfil.

```bash
xos org list              # perfiles guardados; el actual aparece marcado
xos org use client-b      # convierte otro perfil en el predeterminado
xos org list --remote     # organizaciones visibles para la clave actual
xos projects list --profile client-b   # un comando con otro perfil
```

En CI, define `XOS_API_KEY` y `XOS_BASE_URL` y omite `auth login`.

## Llama a las operaciones

```bash
xos resources --tag Finance                     # recursos y sus operaciones
xos ops purchase-orders                         # las operaciones de un recurso
xos projects list --filter project_state.eq=Active --sort -created_at --limit 20
xos projects list --all --fields id,name --output json
xos projects get 0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f
xos projects update 0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f --data '{"name":"Fall Series"}' --if-match auto
xos call purchaseOrders.approve 0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f --data @approval.json
```

`--data` acepta JSON en línea, `@archivo` o `-` para la entrada estándar. `--if-match auto` lee primero el ETag vigente; pasa un ETag real para protegerte de ediciones concurrentes.

## Importa y exporta

```bash
xos import projects --file projects.csv --dry-run
xos import projects --file projects.csv
xos export projects --format csv --out projects.csv --filter project_state.eq=Active
```

Las importaciones por fila envían cada fila a la operación de creación del recurso con un Idempotency-Key derivado del archivo y de la fila, así que repetir después de una falla omite las filas ya importadas. Las celdas CSV vacías se envían como null. Usa NDJSON cuando las columnas necesiten números o booleanos.

Las importaciones del lado del servidor a partir de una hoja de cálculo cargada usan trabajos de importación: `xos import job create --data @job.json`, luego `xos import job dry-run <id>`, `xos import job commit <id>` y `xos import undo <id-de-lote>` para revertir un lote.

## Valida códigos del canon

```bash
xos canon validate --file budget-lines.csv
```

Cada columna con el nombre de un identificador del canon, como `dept_code`, `phase_code` o `cat_urid`, se compara con el canon vigente. Asigna otras columnas con `--column dept=canonDepartments`.

## Prueba webhooks

Consulta [Webhooks](guide:webhooks) para `xos webhooks send`, `verify`, `events` y `replay`.

## Códigos de salida

| Código | Significado                           |
| ------ | ------------------------------------- |
| 0      | Éxito                                 |
| 1      | La solicitud falló                    |
| 2      | El comando se usó de forma incorrecta |
| 3      | Sin sesión, o la clave fue rechazada  |
| 4      | No encontrado                         |
| 5      | Rechazado; se muestra el motivo       |
