---
title: SDK de Python
summary: El paquete xos-sdk para Python 3.9 o posterior, generado a partir del documento OpenAPI, sin dependencias fuera de la biblioteca estándar.
section: tools
order: 8
---

`xos-sdk` cubre cada operación del documento OpenAPI. Sus modelos, métodos y tabla de operaciones se generan a partir del documento en CI y nunca se editan a mano. Usa solo la biblioteca estándar de Python, así que se instala dondequiera que funcione Python 3.9 o posterior.

## Crea un cliente

```python
import os
from xos_sdk import XosClient

xos = XosClient("https://atlas.example.com/api/v1", api_key=os.environ["XOS_API_KEY"])
```

En lugar de `api_key`, pasa `access_token` para un token de OAuth o de sesión, o `get_token` para entregar un token nuevo antes de cada solicitud. Otras opciones: `max_retries` (2 de forma predeterminada) y `timeout` en segundos (30 de forma predeterminada).

## Llama a las operaciones

Los recursos son atributos en snake_case y las operaciones son métodos: `purchaseOrders.approve` es `xos.purchase_orders.approve(po_id, body)`.

```python
response = xos.projects.get(project_id, fields=["name", "project_state"])
project, etag = response.data, response.etag

xos.projects.update(project_id, {"name": "Harborfront Fall Series"}, if_match=etag)
```

Los parámetros de ruta son posicionales y luego va el cuerpo; los parámetros de consulta, `if_match`, `idempotency_key` y `options` son solo por nombre. Las filas son diccionarios tipados como modelos `TypedDict`, así que los editores y verificadores de tipos conocen sus campos.

## Listas

`list()` devuelve una `Page` con `data` y `next_cursor`. `list_all()` entrega cada fila de todas las páginas:

```python
for po in xos.purchase_orders.list_all(filter={"po_state": {"eq": "Approved"}}, sort=["-created_at"]):
    print(po["po_number"])
```

## Escrituras

Los métodos POST envían un `Idempotency-Key` automáticamente y lo reutilizan en los reintentos. Pasa `idempotency_key=` para que una llamada sea segura entre reinicios. Las actualizaciones requieren `if_match`.

## Errores

```python
from xos_sdk import XosRefusalError, XosValidationError

try:
    xos.purchase_orders.approve(po_id, {})
except XosRefusalError as refused:
    print(refused.refusal, refused.reason, refused.rule)
except XosValidationError as invalid:
    print(invalid.errors)
```

Cada clase de error lleva `status`, `problem` y `headers`. Las fallas de transporte lanzan `XosNetworkError`.

## Webhooks

`verify_webhook_signature` y `sign_webhook_payload` se exportan desde `xos_sdk`. Consulta [Webhooks](guide:webhooks).
