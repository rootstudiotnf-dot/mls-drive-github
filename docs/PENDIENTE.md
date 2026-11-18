# Pendiente y huecos detectados

Anotado en la Fase 10 (la fase no añade funciones). Cada punto dice **por qué importa** y **qué haría falta**.

## Para poder lanzar (no se pudo hacer sin cuentas, dominio o herramientas reales)
- [ ] **Desplegar** en producción y pruebas con dominio, HTTPS y correo autenticado (`docs/DESPLIEGUE.md`). *No hecho: no hay cuentas ni dominio.*
- [ ] **Primer simulacro real de restauración** con `pg_dump`/`pg_restore` contra Supabase de pruebas y anotar el tiempo
      (`docs/BACKUPS.md` §3). *Solo se hizo un simulacro lógico en PGlite y el de archivos con simulados.*
- [ ] **Ejecutar `backup-vault`/`restore-files --vault`** de extremo a extremo con los buckets reales.
- [ ] **Lighthouse** (LCP < 2,5 s, CLS < 0,1) sobre el dominio con fotos reales, en móvil y escritorio (`docs/RENDIMIENTO.md`). *La ventana de
      pruebas estaba en segundo plano: el LCP no es fiable.*
- [ ] **Escáner de cabeceras externo** y SSL Labs sobre el dominio real; comprobar `Secure` en cookies bajo HTTPS.
- [ ] **`gitleaks`** (u otro) sobre el historial al crear el repositorio git (H10).
- [ ] **Prueba de carga contra pruebas desplegado** (latencia real).
- [ ] Revisar con la **consola abierta** las pantallas con reproductor, visor y subidas en la build de producción (CSP): solo se revisaron la galería, el estado, el 404 y el mantenimiento.

## Huecos funcionales o de endurecimiento (para decidir después)
- **«Pedir acceso»**: el aviso `access_request` existe pero ningún botón lo dispara (Fase 9).
- **Firmar `Content-Length`** en las subidas simples prefirmadas (H7). Hoy se valida el tamaño exacto en `completeUpload`; firmarlo cortaría el abuso antes de subir los bytes.
- **Firma de contenido** para más formatos (MOV, MP3, AIFF, RAW, HEIC): hoy solo los de firma fija y fiable.
- **`/accesos` exige `access.manage`**: quien crea enlaces sin ese permiso (p. ej. un fotógrafo con `photos.publish`) no tiene pantalla para ver ni revocar los suyos. Una vista «Mis enlaces» lo resolvería.
- **Alertas de transcodificador**: se detectan por el cron (cada ~15 min con el cron externo). Para avisos en segundos habría que un *health check* externo (UptimeRobot, etc.).
- **Cron de Vercel Hobby**: una sola vez al día. Con el cron de GitHub Actions cubierto, pero con retrasos posibles de unos minutos.
- **HTML de ~180 KB** en la galería y el espacio de artista (datos iniciales de 48–500 elementos): paginar si en producción pesa.
- **Dos sondeos de la campana** en móvil (la barra lateral de escritorio sigue montada aunque oculta): 1 petición/minuto de más. Cosmético.
- **Registro de errores propio** mínimo (nombre y código); si crece el uso, valorar un servicio como Sentry (sin datos personales).
- **Eliminar `RESTORE_*` del `.env.local`** después de una restauración: son credenciales de escritura sobre el bucket nuevo.
- **Dependencias de desarrollo** con 7 avisos moderados (`eslint-config-next`): actualizar cuando salga la versión corregida.
