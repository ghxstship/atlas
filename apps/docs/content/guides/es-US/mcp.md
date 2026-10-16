---
title: Servidor MCP
summary: Permite que los agentes de IA lean y, cuando lo autorices, cambien datos de XOS con @xos/mcp, con exactamente los permisos de una clave de API.
section: tools
order: 10
---

`@xos/mcp` es un servidor del Model Context Protocol. Da a un agente de IA herramientas sobre la API pública y actúa como una clave de API en una organización. El agente nunca puede hacer más de lo que la clave permite: cada llamada a una herramienta pasa por la API, que aplica los alcances de la clave, la seguridad a nivel de fila, el enmascaramiento de campos, la separación de funciones y los rechazos.

## Ejecútalo

Agrega el servidor a la configuración de tu cliente MCP:

```json
{
  "mcpServers": {
    "xos": {
      "command": "xos-mcp",
      "env": {
        "XOS_BASE_URL": "https://atlas.example.com/api/v1",
        "XOS_API_KEY": "xos_live_..."
      }
    }
  }
}
```

El servidor habla la revisión 2025-06-18 de MCP por la entrada y la salida estándar.

> Crea una clave dedicada para cada agente, con solo los alcances que necesita y un vencimiento corto. Revócala en Configuración cuando el agente ya no necesite acceso.

## Herramientas de lectura

Siempre disponibles:

| Herramienta              | Hace                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- |
| `xos_list_resources`     | Lista los recursos y sus operaciones, opcionalmente de un módulo                |
| `xos_describe_operation` | Muestra los parámetros de una operación y sus esquemas de solicitud y respuesta |
| `xos_whoami`             | Muestra la persona y la organización por las que actúa la clave                 |
| `xos_list`               | Lista una página de un recurso, con filtros, orden y campos                     |
| `xos_get`                | Lee una fila y su ETag                                                          |
| `xos_read`               | Llama a cualquier otra operación de lectura, como `projects.gateReadiness`      |

## Herramientas de escritura

Desactivadas de forma predeterminada. Actívalas solo para recursos o módulos con nombre:

```bash
xos-mcp --write purchaseOrders,Schedule
XOS_MCP_WRITE=all xos-mcp --allow-delete
```

| Herramienta  | Hace                                                                               |
| ------------ | ---------------------------------------------------------------------------------- |
| `xos_create` | Crea una fila; pasa `idempotency_key` para que una llamada repetida nunca cree dos |
| `xos_update` | Actualiza una fila; necesita `if_match` de `xos_get`                               |
| `xos_action` | Ejecuta una acción POST, como una aprobación o una transición                      |
| `xos_delete` | Mueve una fila a la Papelera; solo con `--allow-delete`                            |

Una escritura fuera del alcance falla con `outside_write_scope` y nunca llega a la API. Dentro del alcance, la API sigue decidiendo: una clave sin la capacidad recibe el rechazo de la propia API.

## Errores que ve el agente

Los problemas de la API vuelven como resultados de herramienta con `isError: true` y el cuerpo de problema completo, para que el agente pueda leer el `reason` de un rechazo e informarlo. Los argumentos mal formados son errores JSON-RPC (-32602).
