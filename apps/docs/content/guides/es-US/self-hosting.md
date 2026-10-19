---
title: Autoalojamiento
summary: Ejecuta XOS en tu propia infraestructura. Cubre la base de datos de Supabase, las variables de entorno, las Edge Functions, el alojamiento de Atlas y Gateway en Vercel o Node, las compilaciones de Compass, las copias de seguridad y las actualizaciones.
section: operate
order: 11
---

XOS es de código abierto bajo AGPL-3.0. Una instalación es un proyecto de Supabase y las aplicaciones que se ejecutan sobre él. Atlas sirve el espacio de trabajo y la API pública en `/api/v1`, Gateway atiende a las partes externas y Compass es la aplicación de campo. Esta guía te lleva de un proyecto vacío a una instalación verificada, en el orden en que dependen las piezas.

## Qué ejecutas

| Componente          | Qué es                                                                                                  | Dónde se ejecuta                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Supabase            | Postgres 17 con cada tabla, política y tarea, más Auth, Storage, Realtime y Edge Functions              | Un proyecto alojado de Supabase, o el Docker Compose de Supabase    |
| Atlas               | La aplicación Next.js del espacio de trabajo y la API pública                                           | Vercel, o cualquier servidor con Node.js 22                         |
| Gateway             | El portal Next.js para crew, proveedores, clientes y otras partes externas, con dominios personalizados | Vercel, o cualquier servidor con Node.js 22                         |
| Docs (opcional)     | Este sitio: guías, centro de ayuda y referencia de la API                                               | Vercel, o cualquier servidor con Node.js 22                         |
| Compass             | La aplicación de campo Expo para iOS y Android                                                          | App Store y Google Play, mediante EAS Build o Xcode                 |
| ClamAV              | Analiza los archivos subidos antes de que otras personas puedan descargarlos                            | Un servidor de contenedores pequeño que las Edge Functions alcancen |
| PowerSync (después) | Transmite los grupos sin conexión a Compass; hasta configurarlo, Compass descarga por la API REST       | Un contenedor junto a la base de datos                              |

## Requisitos

- Node.js 22.12 o posterior y pnpm 10.15.1 (la versión de `packageManager`; Corepack la instala).
- Docker, para la pila local de Supabase y ClamAV.
- La CLI de Supabase 2.x.
- Un clon del repositorio en una etiqueta de versión.

```bash
git clone https://github.com/ghxstship/atlas.git xos
cd xos
git checkout v4.0.0
corepack enable
pnpm install --frozen-lockfile
```

## 1. La base de datos

### Desarrollo local

`supabase/config.toml` define la pila local. Iníciala, aplica cada migración desde cero y ejecuta las pruebas de la base de datos:

```bash
supabase start
supabase db reset
supabase test db
```

`supabase db reset` también carga el inquilino de demostración desde `supabase/seeds`. `supabase start` muestra la URL de la API y la clave anónima.

### Producción

Crea un proyecto de Supabase con Postgres 17 en la región donde deben quedarse los datos de tus clientes. El plan Pro incluye copias de seguridad diarias; la recuperación a un punto en el tiempo es un complemento (consulta Copias de seguridad más abajo).

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Para una pila Compose autoalojada, pasa su cadena de conexión: `supabase db push --db-url "postgresql://postgres:<password>@<host>:5432/postgres"`.

Las migraciones contienen todo lo que necesita una instalación nueva: el canon, los planes y las capacidades, las tareas programadas de la base de datos (pg_cron) y las claves de cifrado en Vault. Ellas mismas crean las claves.

> Nunca cargues `supabase/seeds` en producción. Las semillas son el inquilino de demostración, con una contraseña de demostración compartida. Crea tu primera organización registrándote en Atlas.

Las migraciones solo avanzan. Aplícalas antes de desplegar las aplicaciones que las necesitan.

### Ajustes de Auth

`supabase/config.toml` es solo para la pila local; no ejecutes `supabase config push` con él. Configura esto en el panel del proyecto alojado:

| Ajuste                    | Valor                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Site URL                  | El origen de Atlas, por ejemplo `https://atlas.example.com`                                                    |
| Redirect URLs             | Los orígenes de Atlas y Gateway, más cada dominio personalizado de Gateway                                     |
| Gancho de token de acceso | La función de Postgres `private.custom_access_token_hook` (escribe la reclamación de la organización activa)   |
| Política de contraseñas   | Longitud mínima 12, letras y dígitos, protección contra contraseñas filtradas activada                         |
| MFA                       | Inscripción y verificación TOTP y WebAuthn activadas; la parte confiable de WebAuthn es tu dominio registrable |
| SMTP                      | Tu proveedor de correo, para que los correos de inicio de sesión e invitación salgan de tu dominio             |

El archivo `infra/runbooks/hosted-security-settings.md` del repositorio enumera cada ajuste con su motivo.

## 2. Variables de entorno

Atlas y Gateway validan su entorno al iniciar y nombran cada variable faltante o mal formada. Copia `apps/atlas/.env.example` y `apps/gateway/.env.example` para el desarrollo local.

| Variable                      | Atlas       | Gateway     | Valor                                                                                          |
| ----------------------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                | Obligatoria | Obligatoria | La URL de la API de Supabase                                                                   |
| `SUPABASE_ANON_KEY`           | Obligatoria | Obligatoria | La clave anónima (publicable); la seguridad a nivel de fila protege cada fila                  |
| `ATLAS_SITE_URL`              | Obligatoria |             | El origen público de Atlas, para los enlaces de inicio de sesión y la comprobación CSRF        |
| `GATEWAY_SITE_URL`            | Opcional    | Obligatoria | El origen público de Gateway; Atlas lo usa para los enlaces de avance y de firma               |
| `GATEWAY_PLATFORM_HOSTS`      |             | Opcional    | Los hosts que sirven el Gateway de la plataforma; cualquier otro es un dominio personalizado   |
| `NEXT_PUBLIC_SENTRY_DSN`      | Opcional    | Opcional    | Reporte de errores; sin DSN no se envía nada a Sentry                                          |
| `XOS_TRACES_SAMPLE_RATE`      | Opcional    | Opcional    | Tasa de muestreo de trazas, `0.05` por defecto                                                 |
| `XOS_LOG_LEVEL`               | Opcional    | Opcional    | `info` en producción                                                                           |
| `COMPASS_APPLE_TEAM_IDS`      | Opcional    | Opcional    | Identificadores de equipo de Apple, para que Compass abra los enlaces como enlaces universales |
| `COMPASS_ANDROID_CERT_SHA256` | Opcional    | Opcional    | Huellas del certificado de firma de Compass, para Android App Links                            |

Ninguna de las dos aplicaciones recibe la clave de rol de servicio. Cada llamada a Supabase se ejecuta en el servidor con la sesión de la persona que inició sesión.

## 3. Edge Functions

Despliega cada función de `supabase/functions` y configura sus secretos:

```bash
supabase functions deploy
supabase secrets set --env-file ./functions.env
```

En una pila autoalojada, monta `supabase/functions` en el servicio de funciones de Compose. `stripe-webhook`, `inbound-email`, `email-unsubscribe`, `kiosk-punch` y `api-token` autentican a quien las llama por sí mismas y se despliegan sin verificación de JWT, como declara `supabase/config.toml`.

| Secreto                                                   | Lo usa                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `XOS_API_JWT_SIGNING_KEY`                                 | `api-token`, que cambia claves de API por tokens de corta duración; usa el secreto JWT del proyecto               |
| `SUPABASE_SERVICE_ROLE_KEY`                               | Las funciones de trabajo (Supabase alojado la proporciona automáticamente)                                        |
| `XOS_APP_URL`, `XOS_GATEWAY_URL`, `XOS_POSTAL_ADDRESS`    | Los enlaces y la dirección postal de los correos                                                                  |
| `XOS_EMAIL_TRANSPORT`, `XOS_EMAIL_FROM`, `RESEND_API_KEY` | El correo saliente mediante Resend (`XOS_EMAIL_TRANSPORT=resend`); sin ellos, el correo se registra y no se envía |
| `XOS_EMAIL_ALLOWLIST`, `XOS_EMAIL_DELIVER_TO_ANY`         | Quién puede recibir correo; usa `XOS_EMAIL_DELIVER_TO_ANY=true` solo en producción                                |
| `XOS_INBOUND_SECRET`, `XOS_INBOUND_DOMAIN`                | `inbound-email`, para las respuestas por correo                                                                   |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`              | `stripe-webhook`, solo si cobras mediante Stripe                                                                  |
| `XOS_CLAMAV_HOST`, `XOS_CLAMAV_PORT`                      | `upload-scan`, el demonio de ClamAV; el puerto predeterminado es 3310 (consulta Análisis de archivos subidos)     |
| `SENTRY_DSN`, `XOS_ENVIRONMENT`, `XOS_LOG_LEVEL`          | Reporte de errores y nivel de registro opcionales                                                                 |

### Programa las funciones de trabajo

`webhook-dispatch`, `notification-dispatch`, `upload-scan` y `report-run` hacen su trabajo cuando se llaman con la clave de rol de servicio. Llama a cada una cada minuto. En Supabase alojado, pg_cron y pg_net pueden hacerlo desde la base de datos, leyendo la clave desde Vault:

```sql
select vault.create_secret('<service role key>', 'xos_worker_key');

select cron.schedule('xos_worker_webhook_dispatch', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/webhook-dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'xos_worker_key')
    )
  );
$$);
```

Repite para las otras tres funciones, o llámalas desde cualquier programador que ya uses. Mientras `upload-scan` no se ejecute, los adjuntos no se pueden descargar y los archivos de campo y de incorporación solo llegan a quien los subió.

### Análisis de archivos subidos

Cada archivo subido se analiza con ClamAV, que ejecutas tú mismo con la imagen `clamav/clamav:1.5.4`. Los archivos quedan en cuarentena hasta que el análisis los da por limpios, y un archivo infectado se elimina y se le explica el motivo a quien lo subió.

1. Ejecuta clamd en un servidor al que las Edge Functions lleguen por una red privada. La imagen solo se publica para linux/amd64. Dale al menos 2 vCPU y 4 GiB de memoria, y un volumen persistente en `/var/lib/clamav`. Usa la configuración de `infra/scanning/docker-compose.yaml`, que también funciona tal cual con Docker Compose.
2. clamd no tiene autenticación, así que nunca expongas el puerto 3310 a internet. Llega a él por una red privada o un túnel.
3. Configura los secretos de las funciones `XOS_CLAMAV_HOST` y `XOS_CLAMAV_PORT`, y `XOS_ENVIRONMENT=production`.
4. Llama a `upload-scan` una vez con la clave de rol de servicio. Una respuesta con `"scanner": "clamav"` indica que está conectado.

Sin `XOS_CLAMAV_HOST`, `upload-scan` responde 503 y no analiza nada, así que los archivos siguen en cuarentena. Solo en una pila de desarrollo local marca los archivos como limpios sin analizarlos y registra una advertencia por cada uno. La imagen actualiza sus propias firmas, así que permite HTTPS saliente a `database.clamav.net`. `infra/runbooks/production.md` explica el tamaño, las alertas y las actualizaciones.

### Conoce el límite de la lista de IP permitidas

La lista de IP permitidas de una organización se aplica donde Atlas y la API comprueban una sesión o una clave de API. No se aplica a las llamadas directas a tu endpoint de Supabase (REST, Storage y Realtime) hechas con un token de sesión válido, porque solo Atlas y la API ven la dirección de quien llama. Si dependes de la lista, restringe también quién puede llegar al endpoint de Supabase en el perímetro de tu red. La solución prevista es que todo el acceso a los datos pase por la API.

## 4. Atlas, Gateway y docs

### En Vercel

Crea un proyecto de Vercel por aplicación con estos ajustes y agrega las variables anteriores a los entornos Production y Preview de cada proyecto:

| Proyecto | Directorio raíz | Comando de instalación           | Comando de compilación                       |
| -------- | --------------- | -------------------------------- | -------------------------------------------- |
| Atlas    | `apps/atlas`    | `pnpm install --frozen-lockfile` | `pnpm turbo run build --filter=@xos/atlas`   |
| Gateway  | `apps/gateway`  | `pnpm install --frozen-lockfile` | `pnpm turbo run build --filter=@xos/gateway` |
| Docs     | `apps/docs`     | `pnpm install --frozen-lockfile` | `pnpm turbo run build --filter=@xos/docs`    |

Agrega cada dominio personalizado de Gateway al proyecto de Gateway; las organizaciones verifican su dominio en los ajustes de Atlas.

### En tu propio servidor Node

```bash
pnpm turbo run build --filter=@xos/atlas --filter=@xos/gateway
pnpm --filter @xos/atlas exec next start --port 3000
pnpm --filter @xos/gateway exec next start --port 3001
```

Ejecuta cada aplicación con un gestor de procesos, detrás de un proxy inverso que termine TLS y conserve el encabezado `Host`, para que Gateway reconozca los dominios personalizados.

## 5. Compass

Compass lee su configuración al compilar:

| Variable                        | Valor                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_SUPABASE_URL`      | La URL de la API de Supabase                                                            |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | La clave anónima                                                                        |
| `EXPO_PUBLIC_ATLAS_URL`         | El origen de Atlas                                                                      |
| `EXPO_PUBLIC_GATEWAY_URL`       | El origen de Gateway                                                                    |
| `XOS_UNIVERSAL_LINK_HOSTS`      | Opcional: `atlas:<host>,gateway:<host>`, para que los enlaces de traspaso abran Compass |

Cambia el identificador del paquete y el paquete de Android en `apps/compass/app.json` por los tuyos y compila con EAS Build (agrega un `eas.json` con un perfil `production` y ejecuta `eas build --platform all --profile production`) o localmente con `expo prebuild` seguido de un archivo de Xcode y una compilación de versión de Gradle. Distribuye primero mediante TestFlight y las pruebas internas de Google Play.

## 6. Verifica la instalación

```bash
curl -s "$ATLAS_SITE_URL/api/v1/openapi.json" | head -c 200
XOS_BASE_URL="$ATLAS_SITE_URL/api/v1" XOS_API_KEY="xos_live_..." xos auth status
```

Después regístrate, crea una organización y un proyecto, invita a un miembro y abre el proyecto en Compass.

## 7. Copias de seguridad y restauraciones

| Capa                                 | Qué te da                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Recuperación a un punto en el tiempo | Restaurar a cualquier segundo de los últimos 7 días; necesaria para un punto de recuperación de 1 hora |
| Copias diarias                       | Incluidas en Supabase Pro, se conservan 7 días                                                         |
| Copia lógica semanal                 | `supabase db dump` de roles, esquema y datos, cifrada y guardada en un almacenamiento aparte           |

Una copia de seguridad solo cuenta cuando se ha verificado su restauración. El simulacro de restauración del repositorio restaura un volcado en una base de datos local desechable y comprueba la versión de las migraciones, el número de filas de cada tabla, las sumas de verificación de las tablas clave y las suites de pruebas de la base de datos:

```bash
infra/drills/release-drill.sh
```

Ante un incidente, restaura en un proyecto nuevo, nunca sobre el activo, y luego cambia `SUPABASE_URL` y las claves de las aplicaciones. `infra/runbooks/backup-and-restore.md` tiene el procedimiento completo.

## 8. Actualizaciones

1. Lee las notas de la versión de la etiqueta, haz checkout de la etiqueta y ejecuta `pnpm install --frozen-lockfile`.
2. Haz una copia de seguridad o confirma que la recuperación a un punto en el tiempo está activa.
3. Aplica las migraciones nuevas: `supabase db push`.
4. Despliega las Edge Functions: `supabase functions deploy`.
5. Despliega Atlas, Gateway y docs.
6. Compila Compass cuando las notas de la versión digan que cambió.

Los cambios de la base de datos siguen el patrón de expandir y contraer: ninguna migración de una versión rompe la compilación anterior. Para revertir una aplicación, vuelve a desplegar su compilación anterior; la base de datos nunca se revierte. `/v1` solo cambia de forma aditiva, así que las integraciones de la API existentes siguen funcionando tras cada actualización.
