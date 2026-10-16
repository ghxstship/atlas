---
title: Autenticación
summary: Claves de API para servidores y tokens de sesión para las aplicaciones de XOS. El acceso delegado con OAuth todavía no está disponible.
section: start
order: 2
---

Cada solicitud lleva una credencial como token bearer. La credencial decide quién actúa y en qué organización; no hay encabezado ni segmento de ruta de organización, y `org_id` nunca se acepta en el cuerpo de una solicitud.

## Claves de API

Usa una clave de API para un servidor o un script que actúa por su cuenta.

- Una clave pertenece a una organización y actúa como su propia cuenta de servicio.
- Sus alcances son grupos de capacidades, como `projects` o `finance`. Una solicitud fuera de ellos se rechaza.
- Toda clave vence. Rótala antes con **Rotar** en Configuración, o con `apiKeys.rotate`.
- Envíala como `Authorization: Bearer xos_live_...`.

La API cambia la clave por un token de corta duración de su cuenta de servicio en cada solicitud y lo guarda unos minutos. Luego la seguridad a nivel de fila se aplica a esa cuenta de servicio igual que a un miembro, así que una clave nunca ve más de lo que su cuenta puede ver.

> Mantén las claves en servidores. Nunca incluyas una en un navegador ni en una aplicación móvil, y nunca subas una al control de versiones.

## Aplicaciones que actúan en nombre de una persona

El acceso delegado para aplicaciones de terceros, mediante OAuth 2.1 con PKCE, todavía no está disponible: hoy XOS no ofrece un endpoint de autorización ni de token. Mientras tanto, crea las integraciones de servidor con una clave de API. Esta guía describirá el flujo cuando esté disponible.

## Tokens de sesión

Atlas, Gateway y Compass llaman a la API con tokens de sesión de Supabase de corta duración. La organización es la que se eligió en el selector de contexto.

## Comprueba quién eres

`GET /me` devuelve la persona por la que actúa la credencial y la organización a la que está vinculada:

```bash
curl "$XOS_BASE_URL/me" -H "Authorization: Bearer $XOS_API_KEY"
```

Con la CLI, `xos auth status` muestra lo mismo y `xos org list` muestra un perfil guardado por organización. Cambia con `xos org use <perfil>`.

## Cuando una credencial falla

Una credencial ausente, vencida o revocada devuelve 401 con un cuerpo de problema. Un recurso que la credencial no puede ver devuelve 404, nunca 403, para que la API no revele que existe. Consulta [Errores y rechazos](guide:errors).
