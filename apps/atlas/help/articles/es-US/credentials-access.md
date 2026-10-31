---
title: Credenciales y la cuadrícula de acceso
summary: Emita credenciales por categoría, decida qué zonas abre cada categoría y consulte el registro de escaneos.
kind: page
nodes:
  [
    credentials,
    credentials.categories,
    credentials.issued,
    credentials.access-grid,
    credentials.scan-log,
    project.credentials,
  ]
order: 52
---

## Categorías y credenciales

Una categoría, como Equipo o Artista, define para quién es una credencial. Emita credenciales de una categoría; cada una tiene un número impreso y un código para escanear.

## Cuadrícula de acceso

Es una matriz de categorías y zonas. Cada celda indica si la categoría puede entrar a la zona. Use las flechas para moverse y **Espacio** para cambiar una celda. La vista de tabla muestra las mismas reglas para lectores de pantalla.

## Registro de escaneos

Cada escaneo en una zona se registra con su resultado: permitido o denegado, y por qué. Los escaneos hechos sin conexión en Compass se vuelven a verificar en el servidor cuando el dispositivo se reconecta, y se conservan ambas respuestas.

## Dirección del escaneo y autorizaciones

Cada escaneo es de entrada o de salida. Elija la dirección en el puesto de escaneo, o en el acceso en Compass, donde queda elegida para cada zona. Un escaneo de salida nunca se rechaza y termina el tiempo de la persona en la zona.

Un escaneo de entrada denegado muestra el motivo: la credencial está revocada, aún no es válida o venció, no tiene acceso a la zona, o el escaneo fue fuera del horario de acceso. Las denegaciones registradas antes de este cambio solo indican que se denegaron.

Quien puede emitir credenciales en el proyecto, y no es el titular de la credencial, puede dejar pasar a una persona denegada en un plazo de 15 minutos, con un motivo. El registro conserva la denegación y agrega una entrada Autorizada con quién la dejó pasar y por qué. Nunca se deja pasar una credencial revocada.

## Dentro ahora

El registro de escaneos muestra, para el proyecto elegido, cuántas personas hay ahora en cada zona: las que escanearon la entrada en las últimas 24 horas y no escanearon la salida, por categoría y por equipo. Se actualiza cada 30 segundos. Use Pausar actualizaciones para detenerlo.

## Requisitos antes de emitir

Una categoría puede exigir un curso de capacitación o una certificación. Agréguelos en Requisitos antes de emitir de la categoría. Emitir esa categoría a alguien que no tenga cada uno ahora se rechaza. Los miembros cumplen un curso al aprobarlo; cualquier persona cumple una certificación cuando un verificador la registra, que es como un puesto de pases registra una inducción presencial. El titular de una certificación solo puede cambiar su consentimiento para la verificación pública, nunca sus fechas.

## Revisiones en la página Emitidas

El formulario de emisión muestra lo que bloquea una credencial antes de emitirla: capacitación pendiente, o una credencial vigente de la misma categoría para un periodo que se superpone. Revoque primero la anterior. Los pases de estacionamiento quedan exentos, porque una persona puede tener pases para varios vehículos. También avisa cuando la persona tiene otra credencial en el proyecto, otra persona del proyecto tiene el mismo nombre, o está reservada en otra producción al mismo tiempo.

Emitidas muestra el origen de cada credencial y las mismas revisiones como etiquetas. Elija Requiere atención para ver solo las marcadas.
