# Auditoría de seguridad (Fase 10)

Fecha: 18 nov 2026 · Alcance: todo el código de `src/`, las migraciones `0001`–`0010`, los scripts y los servicios.
Método: revisión de código y de la base de datos, batería SQL, pruebas de extremo a extremo contra la **build de producción**
(`next start`) con Supabase, almacenamiento y correo **simulados**, y pruebas con el navegador. Cada hallazgo se corrige con su
prueba. **Resultado: 0 hallazgos altos o críticos abiertos.** Lo que no se pudo comprobar de verdad está en «Limitaciones».

## Resumen por puntos

| # | Punto | Resultado | Evidencia |
| --- | --- | --- | --- |
| 1 | Permisos en todas las acciones y rutas | **Pasa** (137 acciones, 39 páginas, 5 rutas API) | Tabla al final · `t14` §3–4 |
| 2 | RLS y batería de permisos | **Pasa** (37 de 37 tablas con RLS) · **corregido**: añadidos 8 casos estructurales y 7 de `EXPLAIN` | `permissions.sql` 374/374 · `audit.mjs` |
| 3 | Fuga de datos | **Pasa** | `t14` §5 · `grep` del bundle · 0 coincidencias |
| 4 | IDOR | **Pasa** (17 URLs → 404 y ~50 acciones → denegadas) | `t14` §3–4 |
| 5 | Vault | **Pasa** (132/132 criterios de la Fase 8 sobre la build de producción) | `t12` · `t13` · `t14` |
| 6 | Enlaces externos | **Pasa** | `t13` (95/95) · `token.test.ts` |
| 7 | Subidas | **Corregido** (se añadió la comprobación de la firma real del archivo) | `validate.test.ts` · `t-sig` |
| 8 | Autenticación | **Corregido** (límite propio de intentos) · resto **pasa** | navegador real · código |
| 9 | Cabeceras y navegador | **Corregido** (no había CSP ni HSTS) | `t14` §1 · `csp.test.ts` |
| 10 | Entrada de datos | **Pasa** | `t14` §8 · `validation.ts` |
| 11 | Dependencias | **Pasa** (producción: 0 vulnerabilidades) · 7 moderadas **solo de desarrollo** (anotado) | `npm audit` |
| 12 | Secretos | **Pasa** (con una limitación: la carpeta no es un repositorio git) | escaneo del árbol · bundle |

## Hallazgos

| ID | Sev. | Hallazgo | Estado | Prueba / evidencia |
| --- | --- | --- | --- | --- |
| H1 | **Alta** | No había `Content-Security-Policy` ni `Strict-Transport-Security`. Un fallo de XSS habría tenido las manos libres. | **Corregido.** CSP con *nonce* por petición (generado en el proxy): `script-src 'self' 'nonce-…' 'strict-dynamic'` **sin `unsafe-inline` ni `unsafe-eval`** en producción; `connect/img/media-src` solo la web y los buckets; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri` y `form-action` a `'self'`. HSTS de 2 años, COOP y CORP `same-origin`. Todas las páginas se renderizan por petición (`connection()`) para llevar su nonce. | `t14` §1: los 13 `<script>` de `/login` llevan el nonce; el nonce cambia en cada petición; 4 tests en `csp.test.ts`. Sin violaciones de CSP en la consola del navegador en las pantallas revisadas (galería de 500 fotos, estado, 404 y mantenimiento); el resto de pantallas con subidas, reproductor y visor **no se recorrieron una a una** con la consola abierta. |
| H2 | **Media** | Sin límite propio de intentos de acceso (solo el de Supabase Auth). | **Corregido.** `lib/auth/rate-limit.ts`: 30 por IP y 8 por correo cada 15 min en el login; 10 por IP y 3 por correo en el enlace mágico (la respuesta no cambia, para no revelar si la cuenta existe). IP y correo solo con hash y sal. Falla cerrado. | Navegador real, formulario real: 8 contraseñas malas → «incorrectos»; a partir de la 9.ª «Demasiados intentos», **y la contraseña correcta tampoco entra**. |
| H3 | **Media** | El servidor solo validaba la **extensión** y el tamaño; un ejecutable renombrado a `.jpg` se guardaba. | **Corregido.** `completeUpload` (y `completeVaultUpload`, en el Vault) lee los primeros 16 bytes del objeto (Range) y exige que coincidan con la extensión (JPEG, PNG, WebP, PDF, ZIP/Office, FLAC, WAV, MP4/M4A). Si no, borra el objeto y marca la subida como fallida (falla cerrado si no puede leerlo). | `t-sig`: `.exe` como `.jpg` → rechazado; PDF como `.jpg` → rechazado; JPEG real → aceptado. 1 test unitario (13 casos). |
| H4 | Baja | `parseFilters` se exportaba desde un módulo `"use server"`: era invocable como acción sin sesión (solo parseaba, sin datos). | **Corregido** (ya no se exporta). | El barrido sin sesión de `t14` §2 (137 acciones) no devuelve nada. |
| H5 | Baja | `suggestTags` dejaba a cualquier sesión listar las etiquetas (comunes a todos los beats). | **Corregido:** exige `beats.edit`. | Revisión de código. |
| H6 | Baja | No había páginas 404/500 propias y los errores solo iban a `console.error`. | **Corregido:** `not-found`, `error`, `global-error`, `/mantenimiento` y registro de errores **sin datos** (`error_log`: ámbito, nombre, código). | `t14` §1 y §7; capturas. |
| H7 | Baja | La subida simple por URL prefirmada no fija `Content-Length`: un cliente podría subir más bytes de los declarados. | **Aceptado con mitigación**: `completeUpload` hace `HEAD` y exige el tamaño **exacto** (si no, borra el objeto), hay límite por usuario y la purga elimina subidas abandonadas >48 h. Firmar el `Content-Length` queda en `docs/PENDIENTE.md`. | Código · `storage.sql`. |
| H8 | Baja | `npm audit` (todas las dependencias): 7 moderadas en la cadena de `eslint-config-next → typescript-eslint`. | **Aceptado:** solo dependencias de **desarrollo**; no llegan a producción. Producción: **0**. CI falla si aparece alta/crítica en producción. | `npm audit --omit=dev` |
| H9 | Info | `/admin/estado`, ajustes de beats, registro y accesos del Vault comprueban `roleKey === "owner"` en vez de un permiso. | **Aceptado** (excepción documentada a la regla de «no comprobar por nombre»): el owner es el único rol bloqueado, inmutable y no clonable. | `permissions.sql` (rol bloqueado). |
| H10 | Info | La carpeta del proyecto **no es un repositorio git**: el historial no se puede escanear. | **Pendiente al crear el repositorio**: pasar `gitleaks` antes del primer `push`. El árbol actual está limpio. | Ver punto 12. |

## Detalle de cada punto

### 1. Permisos en acciones y rutas
- **137 acciones de servidor** (19 ficheros). Todas se envuelven en `runAction` y comprueban en servidor, o son públicas por
  diseño (entrada, enlaces, baja) y se protegen con límite + token. La tabla completa está al final.
- **39 páginas**: 36 llaman a `requirePagePermission`/`requireActor`/`getPortalContext`; las 3 restantes son públicas por diseño
  (`/login`, `/invitacion` —valida sesión e invitación en su acción— y `/mantenimiento`).
- **5 rutas API**:

| Ruta | Protección | Resultado |
| --- | --- | --- |
| `GET/POST /api/internal/cron/notifications` y `/cron/ops` | `Authorization: Bearer $CRON_SECRET`, comparación en tiempo constante; si no, **404** | Pasa (`t14` §7) |
| `POST /api/internal/video-callback` | HMAC-SHA256 de `timestamp.nonce.cuerpo` (±5 min), nonce de un solo uso, 401 genérico | Pasa (Fase 6) |
| `POST /api/internal/video-requeue` | Misma firma HMAC | Pasa (Fase 6) |
| `GET /auth/callback` | Código PKCE / `token_hash` de un solo uso; `next` solo rutas internas (`safeNextPath`) | Pasa |
| `GET/POST /api/baja/[token]` | Token firmado (HMAC); el `GET` no cambia nada | Pasa (`t13`) |

### 2. RLS
Consulta estructural (`supabase/tests/permissions.sql`, sección 19) sobre la base ya migrada:
**37 tablas, 37 con RLS**; ningún privilegio de `INSERT/UPDATE/DELETE/TRUNCATE` para `anon` ni `authenticated`; `anon` no tiene
**ningún** privilegio; **0 políticas que no sean de lectura**; toda función `SECURITY DEFINER` fija `search_path`; `anon` no
ejecuta ninguna; los contadores (`rate_hit`, `share_register_*`) solo los ejecuta el servidor; las 9 tablas sin política son de
uso exclusivo del servidor (lista cerrada, vigilada por un caso). Usuarios de la batería: owner, admin, colaborador, artista,
desactivado, sin sesión y *grant* caducado o revocado (374 casos, 0 fallos).

### 3. Fuga de datos
Se buscaron `storage_key`, `token_hash`, `password_hash`, `scrypt$`, claves y URLs firmadas en: **18 páginas del owner y 5 del
portal** (HTML real), **8 respuestas JSON** de listados, `activity_log`, `error_log`, correos, avisos y el bundle del cliente
(`.next/static`: 0 coincidencias para los 9 patrones). Un id inválido devuelve un error genérico (sin trazas ni nombres de tabla).
`storage_key` solo se lee en servidor (`browse`, `uploads`, `ops`, `urls`, `share`, Vault) y nunca se devuelve.

### 4. IDOR
Con **Marta** (artista de otro proyecto): 17 URLs (`/sesiones/<id>`, `/artistas/pepito`, `/archivo/<id>`, `/beats/<id>`,
`/espacio/pepito…`, `/vault…`, `/accesos`, `/usuarios`, `/admin/estado`, `/actividad`, `/ajustes/beats`…) → **404**. Con sus
acciones: URLs, miniaturas, listados, comentarios, mover, papelera, publicar, beats, enlaces, subidas ajenas y escalada de
permisos → **denegadas o vacías, sin datos**, y las filas siguen intactas. Con **Carla** (colaboradora con solo lectura):
ve lo publicado, pero no puede mover, borrar, publicar, comentar ni crear enlaces. Sin sesión: las 137 acciones no devuelven datos.

### 5. Vault
La batería de la Fase 8 (132 criterios: 404, MFA, desbloqueo, caducidad, fail-closed, dos buckets, límite de 50 descargas, mover
con verificación, fuerza bruta) **pasa entera sobre la build de producción**. Fugas: `t13` y `t14` buscan el nombre del archivo
del Vault y su comentario en enlaces, correos (inmediatos, resumen y alertas), avisos, `/comentarios`, `/actividad` y el portal:
**0**. `/almacenamiento` y los contadores excluyen el Vault (Fase 8).

### 6. Enlaces externos
Token de 192 bits, solo se guarda su SHA-256, comparación en tiempo constante, caducidad obligatoria (1/7/30 días, con
`CHECK` en la base de datos), revocación inmediata (también con la cookie de contraseña vigente), 5 fallos por enlace e IP,
descargas contadas de forma atómica y 404 idéntico en todos los casos. 95 comprobaciones en la Fase 9.

### 7. Subidas
Lista cerrada de extensiones + bloqueo explícito de ejecutables y scripts; el MIME del cliente nunca se usa; nombre saneado;
`MAX_UPLOAD_GB`; 50 subidas simultáneas y 500 `initUpload`/hora por usuario; URLs prefirmadas con vida corta, **firmadas con el
`Content-Type` y la clave exactos**; tamaño exacto en `completeUpload` y, desde la Fase 10, firma real del contenido (H3).

### 8. Autenticación
Registro público **desactivado**: la función `handle_new_user` rechaza toda cuenta sin invitación vigente (comprobado en el
simulacro de recuperación: insertar un usuario sin invitación lanza error). En Supabase: *Authentication → Providers → Email →
desactiva «Allow new users to sign up»* (ver `docs/DESPLIEGUE.md`). Invitaciones con caducidad de 7 días y un solo uso (reclamo
atómico). Cierre de sesión global y **validación contra Supabase Auth en cada petición** (`getUser()` en el proxy): una sesión
cerrada o una cuenta desactivada deja de valer al instante (`t14`: cuenta desactivada con token válido → redirigida al login).
Redirecciones solo a rutas internas. Contraseñas de 10–72 caracteres.

### 9. Cabeceras
Verificadas sobre la build de producción: CSP (ver H1), HSTS (2 años, subdominios), `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` + `frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` en `/c/*`
y `/baja/*`), `Permissions-Policy` (cámara, micrófono, geolocalización, pagos y USB desactivados), COOP/CORP `same-origin`,
`X-Robots-Tag: noindex`, sin `X-Powered-By`, `Cache-Control: no-store` en `/c/*`. Cookies de sesión: `HttpOnly`, `SameSite=Lax`,
`Secure` en producción. **CSRF**: las acciones de servidor de Next.js comparan `Origin` con el host y las cookies son
`SameSite=Lax`; las rutas con efectos usan token firmado o secreto. *No se probó con un ataque real*; se apoya en el
comportamiento documentado de Next.js.

### 10. Entrada de datos
Validación a mano en servidor (sin librerías: regla 3 del proyecto) de todo id (UUID), texto (longitud y limpieza), número
(rango), enumerado y lista (tamaño máximo). Los comentarios y títulos se guardan como texto y React los pinta escapados
(`t14` §8: `<img onerror>` y `<script>` no llegan al HTML). Títulos gigantes y ids con SQL → error genérico.

### 11. Dependencias
`npm audit --omit=dev`: **0 vulnerabilidades**. `npm audit`: 7 moderadas, todas en la cadena de lint (desarrollo). Versiones
fijadas por `package-lock.json`; la CI usa `npm ci` y ejecuta `npm audit --omit=dev --audit-level=high`. **No se añadió ninguna
dependencia en la Fase 10** (ni siquiera para las copias: `pg_dump` es una herramienta del sistema, no una dependencia).

### 12. Secretos
Escaneo del árbol (`sk_live`, `sk-…`, `re_…`, `AKIA…`, JWT, claves privadas): **0**. `.env.example` solo trae nombres;
`.gitignore` excluye `.env*`. Variables `NEXT_PUBLIC_*`: solo `SUPABASE_URL`, `SUPABASE_ANON_KEY` (pública por diseño) y
`SITE_URL`. En `.next/static` no aparecen `SUPABASE_SERVICE_ROLE`, `SHARE_LINK_SALT`, `RESEND_API_KEY`, `CRON_SECRET`,
`R2_*SECRET*`, `VAULT_COOKIE_SECRET` ni `storage_key`; la CI lo vuelve a comprobar en cada push. Rotación: `docs/DESPLIEGUE.md` §Claves.

## Limitaciones: qué NO se pudo comprobar

- **Supabase, R2, Resend y Vercel reales**: todo se probó contra simulados. Pueden diferir en detalles (límites de tasa de Auth,
  cabeceras de R2, entrega de correo).
- **`pg_dump`/`pg_restore` reales**: no hay PostgreSQL instalado aquí; `scripts/backup-db.ts` solo se probó en simulacro (`--dry-run`).
- **Cookies `Secure`** y **HSTS** efectivos: requieren HTTPS (la prueba corrió sobre `http://localhost`).
- **CSRF** y la **expiración real del JWT** tras cerrar sesión: no se atacaron; dependen de Next.js y Supabase.
- **Historial de git** (H10) y un **analizador de cabeceras externo** (securityheaders.com): pendientes de hacer sobre el dominio real.
- Las pruebas de IDOR cubren los recursos y acciones inventariados; un recurso nuevo debe añadir su caso (regla 19 de `CLAUDE.md`).

## Cómo repetirlo

```powershell
npm run typecheck ; npm run lint ; npm test ; npm run build
# SQL: supabase/tests/*.sql (ver docs/PRODUCT.md) · e2e: simulados + `next start`
```

## Tabla de acciones de servidor (acción → permiso exigido → resultado)

«Exigido» resume lo que se comprueba **en servidor** (además de RLS en la base de datos). «sesión activa; el alcance lo fija RLS /
`lib/assets/ops.ts`» significa que la acción exige sesión activa y delega el permiso por recurso en `can_access`/RLS (lecturas) o
en las funciones comunes de `lib/assets/ops.ts` (escrituras, que llaman a `can`/`userHasPermission` por elemento).

| Archivo | Acción | Exigido | Resultado | Cobertura |
| --- | --- | --- | --- | --- |
| (admin)/accesos/actions.ts | `createGrant` | access.manage | pasa | IDOR/escritura (t14) |
| (admin)/accesos/actions.ts | `updateGrant` | access.manage | pasa | revisión de código |
| (admin)/accesos/actions.ts | `revokeGrant` | access.manage | pasa | revisión de código |
| (admin)/accesos/actions.ts | `assignMember` | access.manage | pasa | IDOR/escritura (t14) |
| (admin)/accesos/actions.ts | `unassignMember` | access.manage | pasa | revisión de código |
| (admin)/admin/estado/actions.ts | `sendTestAlertEmail` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| (admin)/cuenta/actions.ts | `getMfaStatus` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| (admin)/cuenta/actions.ts | `startTotpEnrollment` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| (admin)/cuenta/actions.ts | `confirmTotpEnrollment` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| (admin)/cuenta/actions.ts | `regenerateRecoveryCodes` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| (admin)/cuenta/actions.ts | `resetMfaWithRecoveryCode` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` · vault.open | pasa | revisión de código |
| (admin)/usuarios/actions.ts | `inviteUser` | users.invite | pasa | IDOR/escritura (t14) |
| (admin)/usuarios/actions.ts | `resendInvitation` | users.invite | pasa | revisión de código |
| (admin)/usuarios/actions.ts | `revokeInvitation` | users.invite | pasa | revisión de código |
| (admin)/usuarios/actions.ts | `setUserStatus` | users.manage | pasa | revisión de código |
| (admin)/usuarios/actions.ts | `changeUserRole` | users.manage | pasa | IDOR/escritura (t14) |
| (admin)/usuarios/roles/actions.ts | `createRole` | roles.manage | pasa | IDOR/escritura (t14) |
| (admin)/usuarios/roles/actions.ts | `saveRole` | roles.manage | pasa | revisión de código |
| (admin)/usuarios/roles/actions.ts | `duplicateRole` | roles.manage | pasa | revisión de código |
| (admin)/usuarios/roles/actions.ts | `deleteRole` | roles.manage | pasa | revisión de código |
| actions/artists.ts | `createArtist` | artists.manage | pasa | IDOR/escritura (t14) |
| actions/artists.ts | `updateArtist` | artists.manage | pasa | revisión de código |
| actions/artists.ts | `setArtistAvatar` | artists.manage | pasa | revisión de código |
| actions/artists.ts | `archiveArtist` | artists.manage | pasa | revisión de código |
| actions/artists.ts | `createFolder` | can:edit | pasa | revisión de código |
| actions/artists.ts | `renameFolder` | can:edit | pasa | revisión de código |
| actions/artists.ts | `reorderFolder` | can:edit | pasa | revisión de código |
| actions/artists.ts | `deleteFolder` | can:edit | pasa | revisión de código |
| actions/artists.ts | `inviteToArtist` | users.invite, access.manage | pasa | revisión de código |
| actions/assets.ts | `updateAsset` | can:publish | pasa | IDOR/escritura (t14) |
| actions/assets.ts | `moveAsset` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/assets.ts | `trashAsset` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/beats.ts | `listBeats` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/beats.ts | `getBeatPlayback` | can:view | pasa | IDOR/escritura (t14) |
| actions/beats.ts | `logBeatPlay` | can:view | pasa | revisión de código |
| actions/beats.ts | `getBeatDownloadUrl` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/beats.ts | `updateBeat` | beats.edit, can:edit, can:publish | pasa | IDOR/escritura (t14) |
| actions/beats.ts | `setBeatCover` | beats.edit, can:edit | pasa | revisión de código |
| actions/beats.ts | `findBeatForAsset` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/beats.ts | `listBeatActivity` | can:edit | pasa | revisión de código |
| actions/beats.ts | `setBeatTags` | beats.edit, can:edit | pasa | revisión de código |
| actions/beats.ts | `suggestTags` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/beats.ts | `reprocessBeat` | can:publish | pasa | revisión de código |
| actions/beats.ts | `shareBeat` | beats.edit, beats.download, can:edit | pasa | IDOR/escritura (t14) |
| actions/beats.ts | `unshareBeat` | beats.edit, can:edit | pasa | revisión de código |
| actions/beats.ts | `createGenre` | beats.edit | pasa | revisión de código |
| actions/beats.ts | `renameGenre` | beats.edit | pasa | revisión de código |
| actions/beats.ts | `mergeGenres` | beats.edit | pasa | revisión de código |
| actions/beats.ts | `deleteGenre` | beats.edit | pasa | revisión de código |
| actions/beats.ts | `saveBeatSettings` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/browse.ts | `listArtistAssets` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/browse.ts | `listArtistFolders` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/browse.ts | `getThumbUrls` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/browse.ts | `listArtistActivity` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/browse.ts | `listTrash` | can:edit, can:delete | pasa | IDOR/escritura (t14) |
| actions/browse.ts | `bulkAssets` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/browse.ts | `restoreAssets` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/browse.ts | `purgeAssets` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/comments.ts | `listComments` | can:edit | pasa | IDOR/escritura (t14) |
| actions/comments.ts | `createComment` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/comments.ts | `editComment` | can:view, can:edit | pasa | IDOR/escritura (t14) |
| actions/comments.ts | `deleteComment` | can:view, can:edit | pasa | IDOR/escritura (t14) |
| actions/comments.ts | `resolveComment` | can:view, can:edit | pasa | IDOR/escritura (t14) |
| actions/comments.ts | `searchMentionable` | can:view | pasa | IDOR/escritura (t14) |
| actions/notifications.ts | `listNotifications` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/notifications.ts | `markNotificationRead` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/notifications.ts | `markAllNotificationsRead` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/notifications.ts | `getPreferences` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/notifications.ts | `savePreference` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | fase 9 (t13) |
| actions/report.ts | `reportClientError` | sesión | Solo guarda nombre y `digest`; tope de 60/min | IDOR/escritura (t14) |
| actions/sessions.ts | `createSession` | photos.edit, photos.publish, can:edit, can:view | pasa | IDOR/escritura (t14) |
| actions/sessions.ts | `updateSession` | can:publish, photos.edit, can:edit, can:view | pasa | revisión de código |
| actions/sessions.ts | `setSessionCover` | photos.edit, can:edit | pasa | revisión de código |
| actions/sessions.ts | `reorderSessionPhotos` | photos.edit, can:edit | pasa | revisión de código |
| actions/sessions.ts | `createSessionFolder` | photos.edit, can:edit | pasa | revisión de código |
| actions/sessions.ts | `renameSessionFolder` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/sessions.ts | `deleteSessionFolder` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/sessions.ts | `setFavorite` | can:view | pasa | IDOR/escritura (t14) |
| actions/sessions.ts | `listMyFavorites` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/sessions.ts | `listSessionFavorites` | can:edit, can:publish | pasa | revisión de código |
| actions/sessions.ts | `listSessionPhotos` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/sessions.ts | `prepareSessionDownload` | can:download | pasa | IDOR/escritura (t14) |
| actions/sessions.ts | `getDownloadUrls` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/sessions.ts | `logSessionZip` | can:download | pasa | revisión de código |
| actions/share.ts | `createShareLink` | can:view, can:download | pasa | IDOR/escritura (t14) |
| actions/share.ts | `listShareLinks` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/share.ts | `getShareLinkDetail` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/share.ts | `revokeShareLink` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/uploads.ts | `initUpload` | beats.edit, can:upload | pasa | revisión de código |
| actions/uploads.ts | `signSingleUpload` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/uploads.ts | `signPart` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/uploads.ts | `listUploadedParts` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/uploads.ts | `completeUpload` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/uploads.ts | `abortUpload` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/uploads.ts | `initDerivative` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/uploads.ts | `completeDerivative` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | revisión de código |
| actions/uploads.ts | `getAssetUrl` | sesión activa; el alcance lo fija RLS / `lib/assets/ops.ts` | pasa | IDOR/escritura (t14) |
| actions/vault-move.ts | `listMoveTargets` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · can:upload | pasa | revisión de código |
| actions/vault-move.ts | `beginMoveIntoVault` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · can:edit | pasa | revisión de código |
| actions/vault-move.ts | `getMoveOutTargets` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · can:edit | pasa | revisión de código |
| actions/vault-move.ts | `beginMoveOutOfVault` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · can:edit | pasa | revisión de código |
| actions/vault-move.ts | `signMoveStep` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/vault-move.ts | `completeMove` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/vault-move.ts | `abortMove` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/vault.ts | `unlockVault` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.open | pasa | revisión de código |
| actions/vault.ts | `lockVault` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/vault.ts | `touchVault` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/vault.ts | `getVaultOverview` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.list, can:view, can:upload | pasa | IDOR/escritura (t14) |
| actions/vault.ts | `listVaultItems` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.list, can:upload, can:edit, can:download, can:delete | pasa | revisión de código |
| actions/vault.ts | `getVaultUrl` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.download, vault.preview | pasa | revisión de código |
| actions/vault.ts | `initVaultUpload` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.upload | pasa | revisión de código |
| actions/vault.ts | `signVaultSingle` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/vault.ts | `signVaultPart` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/vault.ts | `listVaultParts` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/vault.ts | `completeVaultUpload` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.upload | pasa | revisión de código |
| actions/vault.ts | `abortVaultUpload` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/vault.ts | `trashVaultItems` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.trash | pasa | revisión de código |
| actions/vault.ts | `restoreVaultItems` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.restore | pasa | revisión de código |
| actions/vault.ts | `purgeVaultItem` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.delete | pasa | revisión de código |
| actions/vault.ts | `listVaultGrants` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | IDOR/escritura (t14) |
| actions/vault.ts | `createVaultGrant` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.grant | pasa | revisión de código |
| actions/vault.ts | `revokeVaultGrant` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.revoke | pasa | revisión de código |
| actions/vault.ts | `listVaultLog` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.list | pasa | revisión de código |
| actions/vault.ts | `exportVaultLogCsv` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) · vault.list | pasa | revisión de código |
| actions/vault.ts | `listVaultFolderChoices` | `vault.<acción>` + grant vigente + MFA (`requireVaultAccess`) | pasa | revisión de código |
| actions/video.ts | `reprocessVideo` | can:publish | pasa | revisión de código |
| actions/video.ts | `getVideoStates` | can:view | pasa | revisión de código |
| baja/[token]/actions.ts | `unsubscribe` | token firmado (HMAC) de la baja | Solo apaga avisos de esa persona; GET no cambia nada | fase 9 (t13) |
| c/[token]/actions.ts | `shareList` | token de enlace válido | hash + caducidad + revocación + creador con permiso + contraseña | fase 9 (t13) |
| c/[token]/actions.ts | `shareSign` | token de enlace válido | ídem + el archivo pertenece al enlace + límites de descarga | fase 9 (t13) |
| c/[token]/actions.ts | `shareUnlock` | token de enlace válido | 5 fallos/15 min por enlace e IP | fase 9 (t13) |
| c/[token]/actions.ts | `shareComments` | token de enlace válido con comentarios | ídem | fase 9 (t13) |
| c/[token]/actions.ts | `shareAddComment` | token de enlace válido con comentarios | 10 por 10 min por enlace e IP; texto limpio | fase 9 (t13) |
| lib/auth/actions.ts | `signInWithPassword` | pública (formulario de entrada) | Límite 30 por IP y 8 por correo cada 15 min (`rate_hit`); mensaje idéntico exista o no la cuenta | revisión de código |
| lib/auth/actions.ts | `sendMagicLink` | pública (formulario de entrada) | Límite 10 por IP y 3 por correo; respuesta idéntica; `shouldCreateUser:false` | revisión de código |
| lib/auth/actions.ts | `signOut` | sesión propia | Cierra la sesión en Supabase (alcance global) | revisión de código |
| lib/auth/actions.ts | `acceptInvitation` | sesión del invitado + invitación vigente | Reclamo atómico de la invitación (un solo uso, con caducidad) | revisión de código |
