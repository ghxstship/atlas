---
title: Guía rápida
summary: Crea una clave de API, haz tu primera solicitud y lee la respuesta, con curl, TypeScript, Python y la CLI xos.
section: start
order: 1
---

La API pública de XOS es una sola API REST versionada. En el servicio alojado su URL base es `https://api.ghxstship.tech/v1`; una instalación propia la sirve en `/api/v1` del origen de su Atlas. La usan Atlas, Gateway y Compass, y también tus integraciones. Esta guía te lleva de no tener clave a tu primera lista de proyectos.

## Crea una clave de API

1. En Atlas, abre **Configuración** y luego **Claves de API**. Necesitas la capacidad `org.api_keys.manage`.
2. Elige **Crear clave**, ponle el nombre de la integración, elige los alcances que necesita y fija una fecha de vencimiento.
3. Copia la clave. Empieza con `xos_live_` y se muestra una sola vez; Atlas guarda solo su hash.

Una clave de API pertenece a una organización y actúa como su propia cuenta de servicio. Puede hacer lo que permiten sus alcances y nada más. Consulta [Autenticación](guide:authentication) para alcances y tokens de sesión.

## Haz tu primera solicitud

Define dos variables y luego lista los proyectos que la clave puede ver:

```bash
export XOS_BASE_URL="https://api.ghxstship.tech/v1"
export XOS_API_KEY="xos_live_..."

curl "$XOS_BASE_URL/projects?limit=5" \
  -H "Authorization: Bearer $XOS_API_KEY"
```

La respuesta es una página de filas y un cursor a la página siguiente:

```json
{
  "data": [{ "id": "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", "name": "Harborfront Summer Series" }],
  "next_cursor": null
}
```

## Usa un SDK o la CLI

Los SDK y la CLI se generan a partir del mismo documento OpenAPI que esta referencia, así que cada operación está disponible en todos.

```ts
import { XosClient } from "@xos/sdk";

const xos = new XosClient({ baseUrl: process.env.XOS_BASE_URL, apiKey: process.env.XOS_API_KEY });
const page = await xos.projects.list({ limit: 5 });
console.log(page.data.map((p) => p.name));
```

```python
import os
from xos_sdk import XosClient

xos = XosClient(os.environ["XOS_BASE_URL"], api_key=os.environ["XOS_API_KEY"])
for project in xos.projects.list_all(limit=50):
    print(project["name"])
```

```bash
xos auth login --base-url "$XOS_BASE_URL"   # lee la clave de XOS_API_KEY
xos projects list --limit 5
```

## Siguientes pasos

- Pagina, filtra y ordena listas: [Paginación y filtros](guide:pagination-and-filters).
- Crea y actualiza con seguridad: [Escrituras, idempotencia y concurrencia](guide:writes).
- Maneja cada forma de error: [Errores y rechazos](guide:errors).
- Consulta cualquier operación en la [referencia de la API](reference:projects).
