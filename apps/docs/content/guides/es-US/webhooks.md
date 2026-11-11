---
title: Webhooks
summary: Suscríbete a eventos, verifica el encabezado XOS-Signature, maneja los reintentos y repite una entrega.
section: api
order: 6
---

Los webhooks avisan a tu sistema cuando algo cambia en XOS, para que no tengas que consultar constantemente.

## Suscríbete

Crea un destino en **Configuración** y luego **Webhooks**, o con `webhookEndpoints.create`. Indica una URL HTTPS y los eventos que quieres recibir. Lista todos los eventos con `webhookEventTypes.list` o `xos webhooks events`. Los nombres de evento son `{recurso}.{evento}`, por ejemplo `record.created`, `record.state_changed`, `project.gate_passed`, `po.approved`, `invoice.issued`, `timesheet.approved` e `incident.reported`.

Los destinos deben resolver a una dirección pública; XOS se niega a entregar en redes privadas.

## Cómo es una entrega

Cada entrega es un POST con un cuerpo JSON y estos encabezados:

| Encabezado      | Valor                                                   |
| --------------- | ------------------------------------------------------- |
| `XOS-Signature` | `t={segundos unix},v1={hex}`                            |
| `XOS-Event`     | El nombre del evento                                    |
| `XOS-Delivery`  | El identificador de la entrega, igual en cada reintento |

Responde con cualquier estado 2xx en menos de 10 segundos. Cualquier otra respuesta se reintenta con espera exponencial durante 72 horas. Usa `XOS-Delivery` para ignorar una entrega que ya procesaste.

## Verifica la firma

La firma es HMAC-SHA256 de `{timestamp}.{cuerpo}` con el secreto de firma del destino. Verifícala sobre el cuerpo sin procesar, antes de interpretarlo, y rechaza marcas de tiempo de más de cinco minutos para evitar repeticiones.

```ts
import { verifyWebhookSignature } from "@ghxstship/xos-sdk/webhooks";

const result = await verifyWebhookSignature({
  payload: rawBody,
  header: request.headers.get("XOS-Signature") ?? "",
  secret: process.env.XOS_WEBHOOK_SECRET,
});
if (!result.valid) return new Response(null, { status: 400 });
```

```python
from xos_sdk import verify_webhook_signature

result = verify_webhook_signature(raw_body, headers["XOS-Signature"], os.environ["XOS_WEBHOOK_SECRET"])
if not result.valid:
    abort(400)
```

Durante la rotación del secreto, el encabezado puede llevar dos firmas `v1`; acepta la entrega si cualquiera coincide.

## Prueba y repite

- `xos webhooks send --url URL --file body.json --secret-env XOS_WEBHOOK_SECRET` envía una entrega de prueba firmada a tu destino.
- `xos webhooks verify --file body.json --signature "t=...,v1=..." --secret-env XOS_WEBHOOK_SECRET` comprueba una entrega capturada.
- Repite cualquier entrega anterior desde Atlas, con `webhookDeliveries.replay` o con `xos webhooks replay <id-de-entrega>`.
