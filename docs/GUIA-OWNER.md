# Guía del owner

Eres la única persona con acceso total y la única que ve el estado de los servicios (`/admin/estado`), el registro del Vault y el
acceso al Vault. **El Vault es invisible para todos los demás**: si alguien pregunta por él, no existe para esa persona.

## Lo de cada día

### Invitar a alguien
1. `/usuarios` → **Invitar**: correo y rol. Solo puedes dar roles **de menos poder que el tuyo**.
2. La persona recibe un correo (caduca en 7 días, un solo uso), pulsa el enlace y crea su contraseña. Si no llega: **Reenviar**
   (mismo botón) o revisa spam. Una invitación que no quieres: **Revocar**.
3. Para que alguien entre en el espacio de **un artista**, invítalo desde la ficha del artista → pestaña **Accesos**
   (permisos y caducidad).

### Dar acceso a algo concreto
- `/accesos` → «Accesos concedidos» → elige persona, recurso (artista, sesión, carpeta, archivo o beat) y qué puede hacer
  (ver, descargar, subir, editar) y **cuándo caduca**. El rol marca el techo: un acceso nunca da más de lo que permite el rol.
- **Quitar un acceso** es inmediato: botón *Revocar*. Las direcciones de descarga ya emitidas caducan en 2–15 minutos.

### Publicar y retirar
- Lo que sube el equipo queda **privado** («Pendiente de publicar»). Tú (o quien tenga permiso de publicar) lo publicas: selecciona
  archivos → **Publicar**. **Despublicar** lo vuelve privado. Un vídeo no se publica hasta estar procesado; un beat necesita título,
  BPM, tonalidad, género y preview listo.
- Al publicar, las personas con acceso reciben **un solo aviso** agrupado (y un resumen diario por correo).

### Compartir con quien no tiene cuenta
- **Compartir** en una sesión, carpeta, selección de fotos o beat → título, caducidad (1, 7 o 30 días), contraseña opcional, descarga
  y comentarios opcionales. **El enlace se muestra una sola vez**: cópialo. Nada del Vault se puede compartir.
- **Revocar**: `/accesos` → pestaña **Enlaces** → *Revocar ahora* (efecto inmediato). Ahí ves visitas, descargas e historial.

### Revisar lo que pasa
- `/comentarios`: todo lo comentado (abiertos y resueltos). `/actividad`: quién hizo qué y cuándo (no incluye el Vault).
- `/almacenamiento`: espacio usado y coste estimado. La campana (arriba o abajo a la izquierda) son tus avisos; `/cuenta/notificaciones`,
  tus preferencias de correo.

### El Vault
- Solo entra quien tiene el rol adecuado **y** un acceso vigente (que caduca siempre, máximo 90 días) **y** verificación en dos pasos.
  Tú no necesitas acceso concedido, pero sí el segundo factor.
- **Dar acceso**: `/accesos` → «Acceso al Vault» → persona, carpeta (o todo) y caducidad. **Revocar**: mismo sitio, al instante.
- **Registro**: `/vault/registro` (solo tú): cada vista, descarga, subida y concesión queda anotada, con filtros y exportación a CSV.
  Si el registro no se puede escribir, **el Vault deniega** (así debe ser).
- Si pierdes tu móvil: usa un **código de recuperación** de `/cuenta/seguridad` y vuelve a registrar el factor.

## Acceso sospechoso: qué hacer (en este orden)

1. **Corta el acceso** de esa cuenta: `/usuarios` → la persona → **Desactivar** (cierra su sesión al instante). Revoca sus accesos en
   `/accesos` y sus enlaces en *Accesos → Enlaces*.
2. **Mira qué hizo**: `/actividad` (filtra por persona) y, si tenía Vault, `/vault/registro`. Anota hora y qué se descargó.
3. **Si crees que se filtró una clave o una contraseña**: rota las claves afectadas (`docs/BACKUPS.md` §5), empezando por la de
   Supabase si hay duda. Cambia tu contraseña y regenera tus códigos de recuperación.
4. **Si hay un enlace externo implicado**: revócalo y crea otro con contraseña y caducidad corta.
5. **Si temes que haya pérdida de datos**: pon el sitio en mantenimiento (`MAINTENANCE_MODE=1` en Vercel y redesplegar), haz una
   copia (`npm run backup-db`) y sigue `docs/BACKUPS.md` §4.
6. **Avisa** a las personas afectadas con lo que sepas: qué, cuándo y qué han de hacer.
7. Cuando esté resuelto, apunta lo ocurrido y lo aprendido en `docs/PENDIENTE.md`.

## Cada semana / mes / año

- **Semana**: `/admin/estado` (todo «Correcto»; copias de menos de 36 h; sin errores nuevos).
- **Mes**: revisa quién tiene acceso (`/accesos`, `/usuarios`) y desactiva lo que ya no haga falta. Mira el espacio usado.
- **Trimestre**: restaura una copia en pruebas y apunta el tiempo.
- **Año**: rota las claves y revisa los planes de pago (`docs/DESPLIEGUE.md` §8).

## Si algo se rompe
`/admin/estado` te dice qué servicio falla y te avisa por correo. Qué se pierde y qué hacer con cada uno: `docs/BACKUPS.md` §4.
