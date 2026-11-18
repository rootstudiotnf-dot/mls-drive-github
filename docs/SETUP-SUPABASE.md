# Puesta en marcha de Supabase (Fase 1)

Pasos para dejar funcionando el acceso con cuenta e invitaciones. Haz cada paso en orden.

## 1. Crear el proyecto

1. En <https://supabase.com/dashboard> crea un proyecto (elige región cercana, p. ej. UE).
2. Guarda la contraseña de la base de datos en tu gestor de contraseñas (no se vuelve a mostrar).
3. En **Project Settings → API** copia:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - clave `anon` / publishable → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - clave `service_role` → `SUPABASE_SERVICE_ROLE_KEY` (**secreta**: solo en `.env.local`)

## 2. Variables de entorno

```bash
cp .env.example .env.local
```

Rellena `.env.local`. En local, `NEXT_PUBLIC_SITE_URL=http://localhost:3000`; en producción, tu dominio con `https://`.
`OWNER_EMAIL` es el correo con el que entrarás como propietario.

## 3. Aplicar las migraciones

Abre **SQL Editor** y ejecuta, **en este orden**, el contenido de cada archivo:

1. [`supabase/migrations/0001_auth.sql`](../supabase/migrations/0001_auth.sql) — `roles`, `profiles`, `invitations`, funciones, trigger y RLS de acceso.
2. [`supabase/migrations/0002_core.sql`](../supabase/migrations/0002_core.sql) — catálogo de permisos, permisos por rol, contenido (artistas, sesiones, carpetas, assets, beats…), grants, auditoría, la regla `can_access` y RLS.

3. [`supabase/migrations/0003_storage.sql`](../supabase/migrations/0003_storage.sql) — seguimiento de subidas, índices, estado de los assets en RLS, `set_asset_visibility` y `storage_usage`.
4. [`supabase/migrations/0004_artists.sql`](../supabase/migrations/0004_artists.sql) — permiso `artists.manage`, avatar como asset, carpetas con borrado lógico y nombre único, carpetas base por artista (Fotos, Vídeos, Archivos), resúmenes (`artist_summary`, `folder_counts`, `artist_activity`) e índices de listado.

Comprueba después, ejecutando en el mismo editor:

- [`supabase/tests/rls.sql`](../supabase/tests/rls.sql) → debe terminar con `RLS OK`.
- [`supabase/tests/permissions.sql`](../supabase/tests/permissions.sql) → matriz de casos (cada caso imprime `OK`/`FALLO`); debe terminar con `PERMISSIONS OK`.
- [`supabase/tests/explain.sql`](../supabase/tests/explain.sql) → comprueba con `EXPLAIN` que las consultas de assets por artista/sesión usan índice; termina con `EXPLAIN OK`.

- [`supabase/tests/storage.sql`](../supabase/tests/storage.sql) → termina con `STORAGE OK`.
- [`supabase/tests/artists.sql`](../supabase/tests/artists.sql) → casos de la Fase 4 (carpetas base, resúmenes, actividad, acceso entre artistas, revocación); termina con `ARTISTS OK`.

Ninguno deja datos (acaban en `ROLLBACK`). **La migración 0002 es reaplicable**: puedes volver a ejecutarla sin errores y sin pisar los permisos que hayas editado.

**Datos de ejemplo (solo desarrollo):** `npm run seed-demo -- --yes` crea 3 artistas con sesiones, assets (solo metadatos) y 2 beats; con `--big` (`npm run seed-demo -- --yes --big=500`) añade 500 assets a cada artista para probar la paginación. Se niega a ejecutarse con `NODE_ENV=production` o si `NEXT_PUBLIC_SITE_URL` no es local.

Si más adelante cambias algo del catálogo de permisos, hazlo en una migración nueva y actualiza también `src/lib/permissions/keys.ts`.

## 4. Desactivar el registro público

**Authentication → Sign In / Providers → User Signups**: desactiva **Allow new users to sign up**.
(Las invitaciones por la API de administración siguen funcionando.)

Defensa extra: aunque se reactivara por error, el trigger `on_auth_user_created` rechaza cualquier alta cuyo correo no tenga una invitación vigente.
Por eso tampoco funciona **Add user** del panel: toda cuenta nace de una invitación.

Mientras estás ahí:

- **Providers → Email**: deja activado el proveedor *Email* (contraseña y enlace por correo).
- **Authentication → Sign In / Providers → Password**: pon la **longitud mínima de contraseña en 10** (la web ya la exige, pero así se aplica también a llamadas directas a la API).
- **Authentication → Rate Limits**: revisa los límites de correos y de intentos.

## 5. URLs de redirección

**Authentication → URL Configuration**:

- **Site URL**: el valor de `NEXT_PUBLIC_SITE_URL`.
- **Redirect URLs** (añade las dos):
  - `http://localhost:3000/auth/callback`
  - `https://TU-DOMINIO/auth/callback`

## 6. Plantillas de correo (IMPORTANTE)

Por seguridad y para que la sesión quede en cookies HttpOnly del servidor, el enlace de la invitación debe llegar al servidor con el token en la URL (no en el fragmento `#`).
**Authentication → Email Templates → Invite user**: cambia el enlace por

```html
<h2>Te han invitado a MLS Drive</h2>
<p>Abre este enlace para crear tu cuenta (un solo uso):</p>
<p><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite&next=/invitacion">Aceptar invitación</a></p>
```

La plantilla **Magic Link** (enlace para entrar) puede quedarse como viene: `/auth/callback` también admite el formato `?code=`.

> Si dejas la plantilla por defecto, el enlace llegará con el token en `#…` y el servidor no podrá leerlo: la invitación mostrará «El enlace no es válido».

## 7. SMTP propio

El correo integrado de Supabase está pensado solo para pruebas (muy pocos envíos por hora y solo a miembros del equipo).
**Project Settings → Authentication → SMTP Settings**: activa *Custom SMTP* con tu proveedor (Resend, Postmark, Amazon SES, etc.).
Verifica el dominio remitente (SPF/DKIM) para que no caigan en spam.

## 8. Caducidad de invitaciones

La invitación vence a los **7 días** (`invitations.expires_at`): después, `/invitacion` muestra «Invitación caducada» y el servidor rechaza aceptarla.
El enlace del correo, además, tiene la caducidad de OTP de Supabase (**Authentication → Sign In / Providers → Email → Email OTP Expiration**, máximo 24 h).
Si el enlace caduca antes de que lo abran, el administrador usa **Reenviar invitación** (emite un enlace nuevo y renueva los 7 días). Pon el valor de OTP al máximo (86400 s).

## 9. Crear el primer owner

Con `.env.local` completo y la migración aplicada:

```bash
npm run create-owner
```

Requiere Node 22.18 o superior. El script (se ejecuta **una sola vez**):

1. Registra una invitación con rol `owner` para `OWNER_EMAIL`.
2. Envía el correo de invitación.
3. Abre el enlace del correo → `/invitacion` → escribe tu nombre y crea tu contraseña → ya eres owner.

Si ya hay un owner activo no hace nada; si el enlace caducó, vuelve a ejecutarlo y reenvía uno nuevo.

## 10. Arrancar

```bash
npm install
npm run dev
```

Abre <http://localhost:3000>: sin sesión te lleva a `/login`.

## Notas de seguridad

- `SUPABASE_SERVICE_ROLE_KEY` solo se lee en servidor (`src/lib/supabase/admin.ts`, importa `server-only`). Si la filtras, rótala en **Project Settings → API**.
- Las cookies de sesión son HttpOnly. Cerrar sesión invalida la sesión en Supabase.
- Nadie escribe en `roles`, `profiles` ni `invitations` desde el navegador: no hay políticas ni privilegios de escritura. Todo pasa por acciones de servidor que comprueban sesión, estado `active` y rol.
- Desactivar a un usuario pone su perfil en `disabled` (RLS y el proxy le cierran el acceso en su siguiente petición) y bloquea su inicio de sesión y la renovación del token en Auth.
