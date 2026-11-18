# Copias de seguridad y recuperación

Regla de oro: **una copia que nunca se ha restaurado no es una copia.** Esta guía dice qué se copia, cómo se recupera todo en un
entorno nuevo y qué se probó de verdad (ver «Simulacros»).

## 1. Qué se copia, cuándo y dónde

| Qué | Cómo | Frecuencia | Retención | Dónde |
| --- | --- | --- | --- | --- |
| Base de datos (esquemas `public` y `auth`) | Backups automáticos de Supabase **y** `npm run backup-db` (`pg_dump -Fc`) | Diaria | 30 días (`BACKUP_RETENTION_DAYS`) | Bucket de copia, prefijo `db/` |
| Archivos (bucket principal: originales y derivados) | `npm run backup-files` (incremental por tamaño + ETag) | Diaria | Se conserva todo lo que existe en el origen; no borra | Bucket de copia, prefijo `main/` |
| Vault | `npm run backup-vault` (incremental) | Diaria | Ídem | Bucket de copia, raíz (`vault/…`) |

- **Programación**: `.github/workflows/backups.yml` (03:15 UTC) ejecuta las tres. Si prefieres tu máquina o un servidor, el
  comando es el mismo (Windows: Programador de tareas; Linux: `cron`).
- **El bucket de copia debe estar en OTRA cuenta o proveedor** (si es la misma cuenta de Cloudflare, un error o un acceso
  indebido borra original y copia a la vez). Debe ser privado y con un token solo de escritura/lectura de ese bucket.
- Cada ejecución deja una fila en `backup_runs` (solo cifras) que muestra `/admin/estado`, y una alerta por correo al owner si
  falla o pasan más de 36 h sin copia (`/api/internal/cron/ops`).
- El volcado de la base de datos **contiene datos de personas**: bucket privado y acceso mínimo.
- Los objetos de R2 tienen claves **opacas e inmutables** (`artists/{id}/{asset}/original/…`, `vault/{asset}/…`): restaurar el
  bucket con las mismas claves es todo lo que hace falta; la base de datos ya sabe dónde está cada cosa.

### Secretos de la Action de copias
`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_VAULT_BUCKET`, `R2_VAULT_ACCESS_KEY_ID`, `R2_VAULT_SECRET_ACCESS_KEY`, `R2_BACKUP_BUCKET`,
`R2_BACKUP_ENDPOINT`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`. Para el origen basta con tokens de **solo
lectura**; el de la copia, de escritura solo en el bucket de copia.

### Coste aproximado (verifica las tarifas vigentes)
- Cada copia completa de los archivos ocupa lo mismo que el original: en R2 son ~**15 USD por TB y mes** (0,015 USD/GB-mes;
  la salida de datos es gratuita). En proveedores de almacenamiento barato (p. ej. Backblaze B2 o Wasabi) ~**6–7 USD por TB y mes**.
- Con 2 TB de material: ~30 USD/mes la copia en R2, ~13 USD/mes en un proveedor barato. El volcado de la base de datos
  (decenas de MB) es despreciable. Las operaciones de copia (lecturas/escrituras) suman céntimos al mes con un incremental diario.
- Supabase: el plan gratuito **no incluye** backups descargables ni recuperación a un punto en el tiempo; por eso el volcado propio
  es imprescindible. El plan Pro añade backups diarios (7 días) y la recuperación a un punto en el tiempo es un extra de pago.

## 2. Recuperación completa en un entorno nuevo (pasos exactos)

Objetivos de referencia: **RPO** (lo máximo que se pierde) ≈ 24 h; **RTO** (cuánto tarda) de 1 a 3 h en la práctica, dominado por
crear los servicios y por copiar los archivos, no por la base de datos.

1. **Proyecto nuevo de Supabase** (o el pruebas). Sigue `docs/DESPLIEGUE.md` §1: desactiva el registro público, URL de la web y de
   redirección, SMTP propio.
2. **Esquema**: aplica `supabase/migrations/0001_auth.sql` … `0010_ops.sql` **en orden** (SQL Editor o `supabase db push`).
3. **Datos** (descarga el último `db/mls-db-AAAA-MM-DD.dump` del bucket de copia):
   ```powershell
   $env:PGOPTIONS = "-c session_replication_role=replica"   # sin disparadores ni orden de claves ajenas
   pg_restore --data-only --no-owner --no-privileges --schema=public --schema=auth --dbname "$env:NEW_DB_URL" .\mls-db-AAAA-MM-DD.dump
   ```
   Restaura primero la copia en un entorno de pruebas si no estás seguro. Después: `npm run seed-prod -- --check`.
4. **Archivos**: crea un bucket nuevo (y el del Vault) con sus tokens y ejecuta:
   ```powershell
   # RESTORE_* = bucket nuevo · R2_BACKUP_* = bucket de copia
   npm run restore-files            # restaura main/ en la raíz del bucket nuevo (reanudable: repite si se corta)
   npm run restore-files -- --vault # el Vault, en el bucket del Vault nuevo
   ```
5. **Variables**: en Vercel, apunta `NEXT_PUBLIC_SUPABASE_URL`, `…ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_*` y `R2_VAULT_*`
   al entorno nuevo, y **vuelve a desplegar**. Rota las claves (§5) si la causa fue un incidente de seguridad.
6. **Comprueba**: entra como owner → `/admin/estado` (todo «Correcto») → abre una foto, un vídeo y un beat → descarga un archivo →
   `/vault` (pide MFA de nuevo si el factor no estaba en `auth`) → crea una copia nueva (`npm run backup-db`).
7. **Avisa** a las personas con acceso si hubo pérdida de datos entre la última copia y el incidente (qué se subió ese día).

> Los usuarios viven en `auth.users`: el volcado de `auth` los recupera con sus contraseñas (hash) y sus factores MFA. Las
> sesiones abiertas se pierden y todo el mundo tendrá que volver a entrar.

## 3. Simulacros de restauración (hechos el 18 nov 2026)

| Qué | Cómo | Resultado | Tiempo |
| --- | --- | --- | --- |
| **Base de datos** | Se «pierde» una base con 37 tablas y 58 965 filas (20 000 archivos, 5 000 comentarios, 10 000 avisos, 30 usuarios…). Se vuelcan todas las tablas, se crea un entorno **limpio** aplicando solo las migraciones y se cargan los datos. Se compara cada tabla y `auth.users` por recuento y huella MD5. | **Idénticas** (37 tablas + auth). RLS activada en todas tras restaurar. | Volcado 0,5 s (20 MB) · migraciones 1,7 s · carga 1,8 s |
| **Archivos** | 1 005 objetos en un bucket de origen → copia al bucket de copia → restauración a un bucket **nuevo**. Se compara tamaño y ETag de cada objeto. Se repite para comprobar que es incremental y reanudable. | **0 diferencias.** 2.ª copia: 0 copiados, 1 000 «ya estaban»; se añaden 5 y solo se copian 5; 2.ª restauración: 0. La lista paginada (1 000 por página) funciona. | Copia 4,2 s · incremental 1,1 s · restauración 4,1 s |
| **Vault** | `backup-vault` y `restore-files --vault` usan el mismo código que los archivos (otro bucket y prefijo). | **No se ejecutó** el flujo del Vault de extremo a extremo; hazlo en el primer simulacro real. | — |

**Qué NO se probó**, y por qué importa:
- El volcado y la restauración se hicieron con un método **lógico por tablas en PGlite** (equivalente en idea a `pg_restore
  --data-only`), **no con `pg_dump`/`pg_restore` ni contra Supabase real**: no hay PostgreSQL instalado en esta máquina.
  `scripts/backup-db.ts` solo se ejecutó en `--dry-run` (comprueba la configuración y avisa de que falta `pg_dump`). **Haz el primer
  simulacro real en el entorno de pruebas antes de fiarte**, y apunta el tiempo en esta tabla.
- Los tiempos de los archivos son con objetos diminutos y red local: miden el procedimiento, no el ancho de banda. Estimación:
  100 GB a 50 MB/s ≈ 35 min; 1 TB ≈ 6 h (la copia incremental diaria tarda minutos).
- Restaurar `auth` en un Supabase real puede topar con restricciones de permisos del rol `postgres`; el plan B es recrear los
  usuarios con `npm run create-owner` y reinvitar al resto (los perfiles y permisos están en `public` y se conservan).

## 4. Si cae un servicio: qué se pierde y qué hacer

| Servicio | Qué deja de funcionar | Qué se pierde | Qué hacer |
| --- | --- | --- | --- |
| **Vercel** | La web (nadie entra) | Nada: datos y archivos intactos | Esperar. Si dura: crea otro proyecto de Vercel con el mismo repositorio y variables (15 min) y apunta el dominio. Las subidas en curso se reanudan al volver. |
| **Supabase** | Entrar y todo lo que lee datos; las URLs de archivos no se pueden pedir | Nada si la base de datos se recupera; hasta 24 h de cambios si hay que restaurar la copia | Mira su página de estado. Si es una pérdida: §2 (proyecto nuevo + copia). Mientras tanto `/mantenimiento` (`MAINTENANCE_MODE=1`). |
| **R2** | Miniaturas, descargas y subidas (la web abre, sin archivos) | Nada si el bucket vuelve; si no, hasta 24 h de subidas | Crea un bucket nuevo y `npm run restore-files`; cambia `R2_*`. Las URLs firmadas se generan de nuevo solas. |
| **Transcodificador** | Vídeos y beats nuevos no se procesan | Nada: quedan «en cola» | Reinícialo; después `npm run requeue-media-jobs` (3 intentos). `/admin/estado` y la alerta por correo lo detectan. |
| **Correo (Resend)** | Correos de avisos y alertas | Nada: la bandeja (campana) sigue; los inmediatos se reintentan (máx. 5) | Revisa la clave y el dominio; los correos de **Auth** (invitación, enlace mágico) salen del SMTP configurado en Supabase: configúralo con Resend (`docs/DESPLIEGUE.md`). |
| **GitHub (CI y copias)** | Las copias programadas y la CI | Las copias de esos días | Ejecuta `npm run backup-db`/`backup-files` a mano; `/admin/estado` te avisa de que no hay copia reciente. |

## 5. Claves: dónde viven, quién las tiene y cómo se cambian

Custodia: **solo el owner**. Cada secreto vive en **dos** sitios: el panel donde se usa (Vercel *Environment Variables*,
cifradas; GitHub *Secrets*) y **una copia en el gestor de contraseñas del owner**. Nada en el repositorio, en chats ni en capturas.
Frecuencia: **una vez al año**, y de inmediato si hay una sospecha o si alguien con acceso sale del equipo.

| Secreto | Dónde se usa | Cómo se rota | Efecto de la rotación |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` (y `ANON_KEY`) | Vercel, GitHub | Supabase → Settings → API → rotar el *JWT secret*; actualizar Vercel y GitHub; redesplegar | Se cierran todas las sesiones |
| `SUPABASE_DB_URL` | GitHub (solo copias) | Supabase → Database → restablecer contraseña; actualizar el secreto | Ninguno para los usuarios |
| `R2_ACCESS_KEY_ID/SECRET` | Vercel, GitHub | Crear un token nuevo (solo ese bucket), actualizar, **revocar el viejo** | Ninguno (las URLs firmadas ya emitidas caducan solas) |
| `R2_VAULT_*` | Vercel, GitHub | Igual, con un token propio del bucket del Vault | Ninguno |
| `R2_BACKUP_*` | GitHub | Igual, en la cuenta de la copia | Ninguno |
| `VAULT_COOKIE_SECRET` | Vercel | Valor nuevo + redesplegar | Todos vuelven a desbloquear el Vault |
| `SHARE_LINK_SALT` | Vercel | Valor nuevo + redesplegar | Se anulan las contraseñas de enlaces ya desbloqueadas y los enlaces de baja ya enviados; **los enlaces externos siguen valiendo** |
| `CRON_SECRET` | Vercel, GitHub | Valor nuevo en ambos | Ninguno |
| `RESEND_API_KEY` | Vercel, Supabase SMTP | Clave nueva en Resend, actualizar y revocar la vieja | Ninguno |
| `TRANSCODER_HMAC_SECRET` | Vercel y el servicio | Mismo valor nuevo en **ambos** a la vez | Procesos en curso fallan y se reintentan |

Genera cada valor con `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
