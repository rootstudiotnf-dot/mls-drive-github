# Colaboración: enlaces externos, correo con Resend y cron

La Fase 9 añade enlaces externos, comentarios centralizados y avisos. Todo funciona sin correo (la campana sigue
operativa); para enviar correos y resúmenes hace falta Resend y un cron. Esta guía lo deja funcionando.

## 1. Migración

Aplica `supabase/migrations/0009_collab.sql` (idempotente) y, si quieres comprobarla, `supabase/tests/permissions.sql`
(sección 18). No cambia ninguna regla de acceso anterior ni toca el Vault.

## 2. Variables de entorno (solo servidor)

```
SHARE_LINK_SALT=<al menos 32 caracteres aleatorios>
RESEND_API_KEY=re_...
MAIL_FROM="MLS Drive <avisos@tu-dominio.com>"
CRON_SECRET=<al menos 16 caracteres aleatorios>
```

- `SHARE_LINK_SALT` se usa para hashear IPs y firmar el desbloqueo por contraseña y los enlaces de baja. **Sin ella no se
  atiende ningún enlace externo** (falla cerrado). Si la cambias, los enlaces de baja ya enviados y las contraseñas
  desbloqueadas dejan de valer (los enlaces en sí siguen funcionando).
- Sin `RESEND_API_KEY` o `MAIL_FROM` no se envía ningún correo; las notificaciones siguen en la campana.
- Genera cada secreto con `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
- `NEXT_PUBLIC_SITE_URL` debe ser la dirección pública (los enlaces `/c/...` y de baja se construyen con ella).

## 3. Resend

1. Crea una cuenta en Resend y **verifica tu dominio** (registros SPF y DKIM en tu DNS). Sin dominio verificado solo se
   puede enviar a tu propio correo.
2. Crea una **API key** con permiso de envío (*Sending access*) y cópiala en `RESEND_API_KEY`.
3. `MAIL_FROM` debe usar ese dominio. Cada correo lleva enlace de baja y la cabecera `List-Unsubscribe` (un clic).

Los correos llevan **texto y enlaces a la plataforma**: nunca archivos, URLs firmadas ni nada del Vault.

## 4. Cron

El endpoint es `/api/internal/cron/notifications` y exige `Authorization: Bearer <CRON_SECRET>` (si no, responde 404).

- **Vercel Cron** (incluido en `vercel.json`): una vez al día con `?digest=1` — envía el resumen diario, los recordatorios
  de caducidad y lo que hubiera pendiente. Vercel añade solo la cabecera `Authorization` cuando existe la variable
  `CRON_SECRET`. En el plan gratuito de Vercel los cron solo pueden ejecutarse una vez al día.
- **Cron externo cada ~10 minutos** (recomendado para que los correos inmediatos agrupados y los reintentos salgan a
  tiempo): llama a `GET /api/internal/cron/notifications` (sin `digest`) con la cabecera `Authorization: Bearer ...` desde
  cualquier servicio de cron. Los correos inmediatos también se intentan enviar en el momento del suceso.

```
curl -H "Authorization: Bearer $CRON_SECRET" "https://tu-dominio.com/api/internal/cron/notifications?digest=1"
```

La respuesta resume lo hecho (recordatorios, inmediatos enviados/aplazados, resúmenes). No incluye datos de personas.

## 5. Cómo se comportan los avisos

| Aviso | Por defecto |
| --- | --- |
| Subida publicada | Resumen diario (varias fotos = un solo aviso) |
| Comentario | Inmediato |
| Mención | Inmediato |
| Enlace abierto (primera vez) | Inmediato |
| Enlace a punto de caducar (24 h) | Inmediato (una sola vez) |
| Invitación aceptada | Inmediato |
| Beat compartido | Resumen diario |
| Solicitud de acceso | Inmediato (el tipo de aviso existe, pero todavía no hay ningún botón «pedir acceso» que lo dispare) |

Cada persona cambia canal y frecuencia en `/cuenta/notificaciones`. Los avisos de la campana no se apagan. Un correo
inmediato del mismo grupo espera 10 minutos antes del siguiente; los fallos se reintentan con espera creciente (máximo 5).

## 6. Comprobaciones recomendadas

1. Crea un enlace con contraseña y ábrelo en una ventana privada: pide la contraseña, muestra solo lo compartido y
   responde `noindex`, `no-store` y `no-referrer`.
2. Revócalo en **Accesos → Enlaces**: la ventana privada debe dar el mismo 404 que un enlace inventado.
3. Publica varias fotos de un artista y fuerza el resumen: `curl` de arriba con `?digest=1`. Debe llegar **un** correo.
4. En el pie del correo, abre el enlace de baja: muestra una confirmación y no cambia nada hasta pulsar el botón.
5. Comprueba que en `.next/static` no aparecen `SHARE_LINK_SALT`, `RESEND_API_KEY` ni `CRON_SECRET`.
