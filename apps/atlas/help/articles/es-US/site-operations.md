---
title: Operaciones del sitio
summary: Cuente el aforo, vigile el clima, registre la entrada de invitados y lleve el registro de objetos perdidos.
kind: page
nodes: [site-ops, "site-ops.*"]
order: 35
---

## Aforo

Configure un contador para cada espacio que cuenta en las puertas. Su aforo permitido viene de un permiso, de la capacidad del espacio o del factor de carga de ocupantes. Atlas avisa al llegar al 90 por ciento del aforo permitido.

## Clima

Registre lecturas de ráfagas de viento, distancia de rayos e índice de calor, y fije umbrales a partir de su plan de emergencia. Cuando se supera un umbral, el aviso llega a los roles que indicó.

### Servicio oficial

Para una sede con ubicación en EE. UU., active el servicio oficial. Cada 10 minutos, desde tres días antes del proyecto hasta el día después de que termina, registra lecturas de viento y calor de la estación más cercana del Servicio Meteorológico Nacional, guarda los avisos vigentes para la ubicación de la sede y las próximas horas del pronóstico. Sus lecturas se comparan con sus umbrales como las lecturas en el sitio, pero una lectura del servicio nunca baja ni cierra un aviso que alguien registró en el sitio. Un aviso nuevo Grave o Extremo llega una vez a las personas de los roles de alerta y a los despachadores, incluso en horas de silencio. Los avisos se muestran en inglés, como los emite el Servicio Meteorológico Nacional. Los rayos siguen siendo una lectura que usted registra.

### Suspensión por clima y fin de la suspensión

Un despachador puede suspender por clima. El mensaje viene de su texto de suspensión, con el peligro, y puede cambiarlo antes de enviarlo. Llega a la vez a las personas de los roles de alerta, a los despachadores y a todos los que están dentro de las zonas del proyecto. Suspender por clima es la acción principal mientras un aviso está en Restringir o Evacuar o hay un aviso Grave o Extremo vigente. Dé el fin de la suspensión cuando pase; llega a las mismas personas en ese momento. Configure los textos de suspensión y de fin debajo de los umbrales. Una suspensión hecha en Compass sin conexión se rechaza si llega al servidor más de 10 minutos después.

## Entrada de invitados

La lista de la puerta muestra los invitados aprobados en la lista de invitados de Avance. Registrar la entrada de invitados requiere acceso de escaneo en el proyecto.

El pase de un invitado muestra un código que la puerta puede escanear o escribir: la lista de la puerta encuentra al invitado con él, con su tipo de pase, su mesa y su anfitrión. Un pase que no está en la lista lo indica. Cuando un invitado entra, su anfitrión recibe un aviso.

## Objetos perdidos

Registre cada objeto que alguien entrega, con su categoría. Descríbalo lo suficiente para verificar un reclamo, registre cada reclamo y registre la devolución cuando el objeto vuelve a su dueño.

## Lista de evacuación

La lista de evacuación muestra a todos los que están ahora en una zona, por un escaneo de entrada o un fichaje dentro de la geocerca de una zona, y a los invitados que entraron por las puertas en las últimas 24 horas. Las filas se agrupan por zona con el total de cada una. Filtre por proyecto y zona, imprímala con los encabezados en cada página o expórtela. Solo muestra a las personas que usted puede ver: alguien cuyo escaneo más reciente no puede ver puede aparecer en la última zona que sí puede ver. Requiere el registro de escaneos o los registros de horas del proyecto.
