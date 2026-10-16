---
title: Autoalojamiento
summary: Ejecuta XOS en tu propia infraestructura con la CLI de Supabase para desarrollo y la pila Docker Compose de Supabase para producción.
section: operate
order: 11
---

XOS es de código abierto bajo AGPL-3.0. Una instalación es un proyecto de Supabase (Postgres 17, Auth, Storage y Edge Functions) más las aplicaciones Next.js: Atlas sirve la aplicación y la API en `/api/v1`, y Gateway atiende a las partes externas.

## Requisitos

- Node.js 22.12 o posterior y pnpm 10.15.1 (la versión de `packageManager`; Corepack la instala).
- Docker, para la pila de Supabase.
- La CLI de Supabase 2.x.
- Un clon del repositorio.

```bash
git clone https://github.com/ghxstship/atlas.git xos
cd xos
corepack enable
pnpm install
```

## Desarrollo con la CLI de Supabase

`supabase/config.toml` define la pila local. Iníciala y luego aplica cada migración y cada semilla desde cero:

```bash
supabase start
supabase db reset
supabase test db
```

`supabase db reset` carga el canon y el inquilino de demostración desde `supabase/seeds`. `supabase start` muestra la URL de la API y la clave anon.

Configura Atlas copiando `apps/atlas/.env.example` a `apps/atlas/.env.local`:

| Variable            | Valor                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`      | La URL de la API de Supabase                                                                             |
| `SUPABASE_ANON_KEY` | La clave anon (publicable); la seguridad a nivel de fila protege cada fila                               |
| `ATLAS_SITE_URL`    | El origen público de Atlas, usado en los enlaces de inicio de sesión y en la comprobación de origen CSRF |

Atlas valida estas variables al iniciar y nombra cada variable ausente o mal formada.

```bash
pnpm --filter @xos/atlas dev
```

## Producción con Docker Compose

Ejecuta Supabase con su pila oficial de autoalojamiento con Docker Compose (el directorio `docker` del repositorio de Supabase) y sigue la guía de autoalojamiento de Supabase para definir sus secretos: la contraseña de Postgres, el secreto JWT y las claves anon y de rol de servicio generadas con él. Después:

1. Aplica las migraciones de XOS a esa base de datos: `supabase db push --db-url "postgresql://postgres:PASSWORD@HOST:5432/postgres"`.
2. Carga el canon y tu primera organización con los archivos de semilla de `supabase/seeds`, en orden de nombre de archivo.
3. Despliega las Edge Functions de `supabase/functions` en el servicio de funciones de la pila y define sus secretos.
4. Compila e inicia Atlas y Gateway con las variables anteriores.

```bash
pnpm build
pnpm --filter @xos/atlas start
```

## Secretos de las Edge Functions

| Secreto                                       | Lo usa                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `XOS_API_JWT_SIGNING_KEY`                     | `api-token`, que cambia claves de API por tokens de corta duración; defínelo con el secreto JWT del proyecto |
| `SUPABASE_SERVICE_ROLE_KEY`                   | Las funciones de trabajo; nunca lo entregues a Atlas ni a un navegador                                       |
| `XOS_APP_URL` y `XOS_POSTAL_ADDRESS`          | `notification-dispatch`, para los enlaces y la dirección postal de los correos                               |
| `XOS_INBOUND_SECRET` y `XOS_INBOUND_DOMAIN`   | `inbound-email`                                                                                              |
| `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` | `stripe-webhook`, solo si cobras con Stripe                                                                  |

`webhook-dispatch` y `notification-dispatch` se ejecutan de forma programada con la clave de rol de servicio; prográmalas con el cron de tu plataforma.

## Verifica la instalación

```bash
curl "$ATLAS_SITE_URL/api/v1/openapi.json" | head -c 200
XOS_BASE_URL="$ATLAS_SITE_URL/api/v1" XOS_API_KEY="xos_live_..." xos auth status
```

## Actualizaciones

Descarga la nueva versión, ejecuta `pnpm install`, aplica las migraciones nuevas con `supabase db push`, vuelve a desplegar las funciones y compila de nuevo las aplicaciones. Las migraciones solo avanzan y `/v1` cambia solo de forma aditiva, así que las integraciones existentes siguen funcionando.
