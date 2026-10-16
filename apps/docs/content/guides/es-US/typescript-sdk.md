---
title: SDK de TypeScript
summary: El cliente @xos/sdk, generado a partir del documento OpenAPI, con modelos tipados, paginación, filtros, idempotencia, ETag y errores de problema.
section: tools
order: 7
---

`@xos/sdk` cubre cada operación del documento OpenAPI. Sus modelos, firmas de métodos y tabla de operaciones se generan a partir del documento en CI y nunca se editan a mano, así que una operación nueva aparece en el SDK en cuanto aparece en la API. Funciona en Node.js 22 o posterior, en navegadores y en entornos edge, sin dependencias.

## Crea un cliente

```ts
import { XosClient } from "@xos/sdk";

const xos = new XosClient({
  baseUrl: "https://atlas.example.com/api/v1",
  apiKey: process.env.XOS_API_KEY,
});
```

En lugar de `apiKey`, pasa `accessToken` para un token de OAuth o de sesión, o `getToken` para entregar un token nuevo antes de cada solicitud. Otras opciones: `maxRetries` (2 de forma predeterminada), `timeoutMs` (30000 de forma predeterminada) y un `fetch` propio.

## Llama a las operaciones

Cada recurso es una propiedad y cada operación un método con el nombre de su id de operación: `projects.list` es `xos.projects.list()`, `purchaseOrders.approve` es `xos.purchaseOrders.approve(id, body)`.

```ts
const { data: project, etag } = await xos.projects.get(projectId, {
  fields: ["name", "project_state"],
});

await xos.projects.update(projectId, { name: "Harborfront Fall Series" }, { ifMatch: etag! });

await xos.records.transition(recordId, {
  expected_state: "Scheduled",
  to_state: "Blocked",
  blocker_text: "Waiting on the rigging plot.",
});
```

Cada resultado tiene `data`, `status`, `etag`, `rateLimit` y `headers`. Primero van los parámetros de ruta, luego el cuerpo, luego los parámetros de consulta y al final las opciones.

## Listas

`list()` devuelve una página con `data` y `nextCursor`. `listAll()` recorre cada fila de todas las páginas. Los filtros y el orden están tipados según la fila:

```ts
for await (const po of xos.purchaseOrders.listAll({
  filter: { po_state: { eq: "Approved" } },
  sort: ["-created_at"],
  fields: ["id", "po_number", "currency_code"],
})) {
  console.log(po.po_number);
}
```

## Escrituras

Los métodos POST envían un `Idempotency-Key` automáticamente y lo reutilizan en los reintentos. Pasa `idempotencyKey` para que una llamada sea segura entre reinicios. Las actualizaciones requieren `ifMatch`; el sistema de tipos no te deja omitirlo.

## Errores

```ts
import { XosPreconditionFailedError, XosRefusalError, XosValidationError } from "@xos/sdk";

try {
  await xos.purchaseOrders.approve(poId, {});
} catch (error) {
  if (error instanceof XosRefusalError) console.log(error.refusal, error.reason, error.rule);
  else if (error instanceof XosValidationError) console.log(error.errors);
  else if (error instanceof XosPreconditionFailedError) console.log("Read again and retry");
  else throw error;
}
```

Consulta [Errores y rechazos](guide:errors) para ver cada clase.

## Webhooks

`verifyWebhookSignature` y `signWebhookPayload` se exportan desde `@xos/sdk/webhooks`. Consulta [Webhooks](guide:webhooks).

## Llamar a una operación por su id

`xos.request(OPERATIONS["projects.get"], { path: { id } })` llama a cualquier operación de la tabla generada. La CLI y el servidor MCP están hechos así.
