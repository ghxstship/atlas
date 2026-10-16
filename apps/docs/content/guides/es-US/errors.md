---
title: Errores y rechazos
summary: Detalles de problema RFC 9457, punteros de validación, rechazos y sus motivos, campos enmascarados y límites de frecuencia.
section: api
order: 5
---

Cada error es un cuerpo `application/problem+json` con `type`, `title`, `status`, `detail` e `instance`. El `type` es un URI estable como `/problems/not-found`; compara con él, no con `title`.

## Estados

| Estado | Significado                                                                                   | Qué hacer                                 |
| ------ | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 400    | Solicitud mal formada, como un parámetro de consulta desconocido o un Idempotency-Key ausente | Corrige la solicitud                      |
| 401    | Credencial ausente, vencida o revocada                                                        | Renueva la credencial                     |
| 404    | El recurso no existe, o no tienes permiso para verlo                                          | Revisa el identificador y tu acceso       |
| 409    | Conflicto, como una clave de idempotencia reutilizada con otro cuerpo                         | Usa una clave nueva para una acción nueva |
| 412    | `If-Match` está desactualizado                                                                | Lee otra vez y reintenta                  |
| 422    | La validación falló, o una regla rechazó la solicitud                                         | Lee `errors` o `refusal`                  |
| 428    | Falta `If-Match`                                                                              | Envía el ETag que leíste                  |
| 429    | Límite de frecuencia alcanzado                                                                | Espera lo que indica `Retry-After`        |

## Errores de validación

Un 422 con `errors` indica un JSON Pointer por cada miembro inválido:

```json
{
  "type": "/problems/validation",
  "title": "Unprocessable Content",
  "status": 422,
  "errors": [{ "pointer": "/currency", "detail": "must match ^[A-Z]{3}$" }]
}
```

## Rechazos

Un 422 con `refusal` significa que XOS se negó a responder o a actuar, y `reason` explica por qué:

| Rechazo      | Significado                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `NO_ANSWER`  | Los datos necesarios para responder todavía no existen. XOS no adivina.                                                 |
| `UNRATIFIED` | El valor existe pero no se ha ratificado, así que no se puede confiar en él.                                            |
| `REFUSE`     | Una regla prohíbe la acción, como una transición no permitida o una regla de separación de funciones. `rule` la nombra. |

Un rechazo es una respuesta, no una falla. Muestra el motivo a la persona y nunca lo reintentes sin cambios.

## Campos enmascarados

Un campo restringido que no puedes leer permanece en la respuesta como `{ "masked": true, "reason": "..." }`, así que la forma de la fila nunca cambia según tu acceso.

## Límites de frecuencia

Cada respuesta incluye `RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset`. Un 429 incluye `Retry-After` en segundos. Los SDK esperan y reintentan los 429, 502, 503 y 504 por ti, dos veces de forma predeterminada, con el mismo Idempotency-Key.

## En los SDK

Cada estado lanza su propia clase de error: `XosValidationError`, `XosRefusalError` (con `refusal`, `reason` y `rule`), `XosPreconditionFailedError`, `XosNotFoundError`, `XosRateLimitError` y otras, todas subclases de `XosApiError` con el `problem` completo. Las fallas de transporte lanzan `XosNetworkError`.
