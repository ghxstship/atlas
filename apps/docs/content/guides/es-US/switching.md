---
title: Cambio de proveedor
summary: Lleve su organización a otro proveedor o a su propia instalación, con la exportación completa, 30 días de soporte de transición y sin cargos por cambio desde el 12 de enero de 2027.
section: operate
order: 14
---

Puede llevar su organización de XOS a otro proveedor, o a su propia instalación de XOS, en cualquier momento. La sección 11.3 de los Términos del servicio establece lo que GHXSTSHIP hace cuando usted cambia: exportar todos los datos y metadatos exportables en los formatos estructurados que se documentan aquí, dar 30 días de soporte de transición si lo pide y, desde el 12 de enero de 2027, no cobrar cargos por cambio. Esta guía es el proceso; los Términos son el texto vinculante.

## Qué recibe

- **Sus datos y metadatos**, en la [exportación completa](guide:full-export): cada tabla de su organización en JSON y CSV, los archivos guardados y un manifiesto, descritos columna por columna en el [diccionario de datos](dictionary:).
- **30 días de soporte de transición**, si lo pide: ayuda para leer la exportación, relacionar sus tablas con el nuevo sistema y obtener los archivos y las columnas que el archivo deja fuera, sujeto a controles de seguridad.
- **Sin cargos por cambio desde el 12 de enero de 2027.** Desde esa fecha GHXSTSHIP no cobra cargos por cambio, ni por la exportación, ni por el soporte de transición, ni por nada más que el cambio requiera. Su suscripción es aparte: terminarla sigue la sección 11.1 de los Términos, y la sección 5.10 dice qué pasa con los cargos ya pagados.

## Cambie

1. **Pida el soporte de transición.** El Propietario o un administrador contacta al equipo de la plataforma desde **Configuración, Ayuda y soporte** en Atlas, o escribe al buzón de soporte que figura en la página de contacto publicada con los Términos. Indique que cambia de proveedor y el día en que quiere que empiecen los 30 días. Si su organización está establecida en la Unión Europea, inicie el cambio con un aviso al buzón de avisos legales, como dice la sección 11.3 de los Términos. El equipo de la plataforma abre los datos de su organización para esto solo en una sesión de soporte que conceda el Propietario.
2. **Descargue una exportación completa de prueba.** El Propietario la descarga desde **Configuración, Zona de peligro** (vea [Exportación completa](guide:full-export)). Cárguela en el nuevo sistema y compare los conteos con `manifest.json`.
3. **Traslade el trabajo.** Siga usando XOS hasta que el nuevo sistema esté listo. Para una instalación propia, la guía de [autoalojamiento](guide:self-hosting) explica la configuración, y las tablas de la exportación tienen los mismos nombres y columnas que las de una instalación de la misma versión de XOS.
4. **Descargue la exportación final** el día en que deje de usar XOS, para que incluya todo hasta ese día.
5. **Cancele.** El Propietario cancela en **Configuración, Zona de peligro**. Al cancelar, la suscripción termina de inmediato en Stripe, sin más cargos, y le confirmamos por correo cuando Stripe la acepta. La organización queda en solo lectura de inmediato, el Propietario puede reactivarla en el plan Access durante 30 días y la exportación completa sigue disponible hasta la eliminación. El día 90, GHXSTSHIP elimina sus datos del servicio en vivo y envía al Propietario un certificado de eliminación.

Los registros que la ley le obliga a conservar, como los de nómina e impuestos, se eliminan el día 90 junto con todo lo demás. Los importes de pago, los identificadores fiscales y los medios de campo no están en la exportación, así que conserve lo que pueda de la exportación y pida pronto el resto escribiendo al buzón de avisos legales antes de la eliminación, como dice la sección 11.2 de los Términos.

## Otras formas de leer sus datos

Mientras cambia, estas siguen funcionando junto a la exportación:

- La API pública en `/api/v1` lee y escribe sus registros uno a uno o por páginas ([referencia de la API](reference:projects)).
- En el plan Enterprise, la [entrega al almacén de datos](guide:warehouse-delivery) copia sus datos en su propio bucket cada noche.
