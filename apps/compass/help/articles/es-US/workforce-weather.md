---
title: Clima
summary: Cómo registrar lecturas de viento, rayos y calor, y ver las alertas activas.
kind: workflow
nodes: [workforce.weather]
order: 1
---

Clima muestra las alertas activas, las lecturas recientes y los umbrales del proyecto.

Elige **Registrar una lectura**, elige viento, rayos o calor, escribe el valor y elige **Guardar lectura**. Una lectura que pasa un umbral genera una alerta: Vigilar, Restringir o Evacuar.

Los umbrales se definen en Atlas.

En un recinto de EE. UU. con el servicio oficial activado, Clima también muestra los avisos del Servicio Meteorológico Nacional para el recinto.

Quien despacha puede elegir **Suspender por clima**: escribe o deja el mensaje y envíalo. Llega a las personas de los roles de alerta, a quienes despachan y a todos los que están dentro de las zonas del proyecto. **Fin de la suspensión** la termina. Sin conexión, ambos esperan en la Cola sin conexión. Una suspensión que llega tarde se envía igual y dice cuándo la declaraste; un fin de suspensión que llega al servidor más de 10 minutos después de darlo no se envía, así que revisa el clima y dalo de nuevo.
