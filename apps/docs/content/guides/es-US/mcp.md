---
title: Servidor MCP
summary: Conecta Claude, ChatGPT u otro agente de IA a XOS con el extremo MCP alojado, donde cada cambio es una propuesta que tú confirmas, o ejecuta @xos/mcp con una clave de API.
section: tools
order: 10
---

`@xos/mcp` es un servidor del Model Context Protocol. Da a un agente de IA herramientas sobre la API pública. XOS lo aloja para asistentes como Claude y ChatGPT, que actúan por la persona que los conectó, y también puedes ejecutarlo tú, actuando como una clave de API en una organización. El agente nunca puede hacer más de lo que la clave permite: cada llamada a una herramienta pasa por la API, que aplica los alcances de la clave, la seguridad a nivel de fila, el enmascaramiento de campos, la separación de funciones y los rechazos.

## Extremo alojado para Claude y ChatGPT

El extremo alojado es `https://api.ghxstship.tech/mcp` (o `/api/mcp` en tu dirección de Atlas cuando tu XOS no tiene un host de API aparte). Habla Streamable HTTP, revisiones MCP 2025-06-18 y 2025-03-26, sin sesiones: cada solicitud es independiente.

Solo acepta un token de acceso OAuth de una aplicación registrada en tu organización. El registro dinámico de clientes está desactivado, así que un administrador registra primero cada asistente:

1. En Configuración, Integraciones, Conectores de asistentes de IA, un administrador elige Claude, ChatGPT u otro cliente MCP, marca los grupos de capacidades que puede alcanzar de forma predeterminada y lo registra. Los grupos que alcanzan datos restringidos o el control de la organización nunca son predeterminados.
2. El panel muestra la URL del servidor MCP y el ID de cliente OAuth. En Claude, abre Configuración, Conectores, Agregar conector personalizado, pega la URL, abre Configuración avanzada y pega el ID de cliente sin secreto. En ChatGPT, abre Configuración, Conectores, Crear, pega la URL, elige OAuth y pega el ID de cliente.
3. Cada persona que se conecta inicia sesión en XOS y da su consentimiento en la pantalla de consentimiento. Los grupos con datos restringidos piden un segundo factor reciente.

El extremo publica sus metadatos OAuth en `/.well-known/oauth-protected-resource` y `/.well-known/oauth-authorization-server`, solo con PKCE S256 y sin extremo de registro. Una solicitud sin un token válido recibe 401 con un encabezado `WWW-Authenticate` que nombra esos metadatos.

### Los cambios son propuestas

En el extremo alojado, cada herramienta de escritura (`xos_create`, `xos_update`, `xos_action`, `xos_delete`) propone el cambio en lugar de hacerlo. Nada cambia hasta que la persona lo confirma en Configuración personal, Aplicaciones conectadas, un cambio a la vez; la herramienta responde con el enlace para revisarlo. Al confirmar, el cambio se ejecuta con el acceso de la propia persona y con la ETag del registro, así que un cambio propuesto sobre datos desactualizados falla de forma segura. Una propuesta vence a los 7 días, y de inmediato cuando la persona deja de permitir que la aplicación actúe por ella. La aplicación nunca puede confirmar una propuesta, y la base de datos rechaza cualquier cambio que intente hacer directamente.

Los datos que lee un asistente van al proveedor de ese asistente según tus instrucciones. Si tu organización limita el acceso a la API por dirección IP, permite también las direcciones de tu proveedor de IA.

## Ejecútalo tú mismo

Agrega el servidor a la configuración de tu cliente MCP:

```json
{
  "mcpServers": {
    "xos": {
      "command": "xos-mcp",
      "env": {
        "XOS_BASE_URL": "https://api.ghxstship.tech/v1",
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
