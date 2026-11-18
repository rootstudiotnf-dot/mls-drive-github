# Despliegue, dominio y entornos

Esta guía deja la plataforma en producción con dominio propio, HTTPS, correo autenticado y CI. **Nada de esto se ha hecho todavía**
(no hay cuentas ni dominio en este equipo): es el procedimiento a seguir, comprobado en lo posible contra la build y los
scripts del proyecto. Marca cada paso al hacerlo y anota la fecha en `docs/LANZAMIENTO.md`.

## 0. Dos entornos, nada compartido

| | Producción | Pruebas |
| --- | --- | --- |
| Supabase | proyecto `mls-drive-prod` | proyecto `mls-drive-test` |
| R2 | `mls-drive-prod` + `mls-drive-prod-vault` | `mls-drive-test` + `mls-drive-test-vault` |
| Vercel | proyecto `mls-drive` (rama `main`) | proyecto `mls-drive-test` (rama `pruebas`) |
| Dominio | `drive.tu-dominio.com` | `pruebas.tu-dominio.com` |
| Correo | dominio verificado | el mismo dominio, remitente distinto |
| Copias | sí (diarias) | no hace falta |

**Nunca** apuntes pruebas a los buckets o a la base de producción (ni al revés). Cada entorno tiene sus **propias** claves
(`docs/BACKUPS.md` §5) y su propio `CRON_SECRET`, `SHARE_LINK_SALT` y `VAULT_COOKIE_SECRET`.

## 1. Supabase (por entorno)

1. Crea el proyecto (región cercana a tus usuarios; en la UE, Fráncfort).
2. **SQL Editor**: aplica `supabase/migrations/0001_auth.sql` … `0010_ops.sql` en orden. Todas son idempotentes.
3. **Authentication → Providers → Email**: **desactiva «Allow new users to sign up»** (cuentas solo por invitación; la base de datos
   ya rechaza cuentas sin invitación) y activa «Confirm email».
4. **Authentication → URL Configuration**: *Site URL* = `https://drive.tu-dominio.com`; *Redirect URLs* =
   `https://drive.tu-dominio.com/auth/callback` (y solo esa). En pruebas, el dominio de pruebas.
5. **Authentication → Email Templates** (marca): «Invite user» y «Magic Link» con el texto de `docs/SETUP-SUPABASE.md` (enlace a
   `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite` / `…type=magiclink`). Pon el nombre «MLS Drive» y el
   logotipo de texto; sin imágenes de terceros.
6. **Authentication → SMTP Settings**: SMTP propio con Resend (`smtp.resend.com`, usuario `resend`, contraseña = API key),
   remitente `no-responder@tu-dominio.com`. Sin esto los correos de Auth salen del remitente compartido de Supabase (límite
   muy bajo y caen en spam).
7. **Database → Backups**: comprueba qué incluye tu plan (§6). Anota la cadena de conexión para `SUPABASE_DB_URL` (solo copias).
8. Crea el owner: `npm run create-owner` (con `OWNER_EMAIL`) y luego `npm run seed-prod -- --check`.

## 2. Cloudflare R2 (por entorno)

1. Dos buckets **privados** (principal y Vault), sin dominio público ni `r2.dev`.
2. Un token de API **por bucket** (Object Read & Write, solo ese bucket): `R2_ACCESS_KEY_ID/SECRET` y `R2_VAULT_*`.
3. **CORS** de cada bucket, **restringido a tu dominio** (nunca `*`):
   ```json
   [{
     "AllowedOrigins": ["https://drive.tu-dominio.com"],
     "AllowedMethods": ["GET", "PUT", "HEAD"],
     "AllowedHeaders": ["content-type", "content-length", "x-amz-*"],
     "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Content-Disposition"],
     "MaxAgeSeconds": 3600
   }]
   ```
   (`docs/SETUP-R2.md` explica cada campo.) En pruebas, solo el dominio de pruebas. La CSP de la web ya limita las conexiones al
   endpoint de R2 (`https://<cuenta>.r2.cloudflarestorage.com`).
4. Bucket de copia en **otra cuenta o proveedor** (`docs/BACKUPS.md`).

## 3. Vercel

1. Importa el repositorio. **Production Branch = `main`**; las demás ramas generan *previews* (no producción).
2. **Environment Variables** (solo en *Production*; copia desde `.env.example`, sin las de copias ni `RESTORE_*`):
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL`
   (`https://drive.tu-dominio.com`), `R2_*`, `R2_VAULT_*`, `VAULT_COOKIE_SECRET`, `SHARE_LINK_SALT`, `RESEND_API_KEY`,
   `MAIL_FROM`, `CRON_SECRET`, `STORAGE_QUOTA_GB`, `TRANSCODER_URL`, `TRANSCODER_HMAC_SECRET`, `MAX_UPLOAD_GB`.
3. Marca como **Sensitive** todas menos las `NEXT_PUBLIC_*`. No las pongas en *Preview* con valores de producción.
4. `vercel.json` ya programa dos tareas diarias (resumen de avisos y estado). El resto de tareas frecuentes las hace
   `.github/workflows/cron.yml` (§7).
5. **Dominio**: Settings → Domains → añade `drive.tu-dominio.com` (y `www`, si lo usas, con **redirección** al principal).

## 4. Dominio y HTTPS

1. Compra o usa tu dominio. En el DNS (Cloudflare, tu registrador…):
   - `drive` → **CNAME** `cname.vercel-dns.com` (o el valor exacto que Vercel te indique al añadir el dominio).
   - Si sirves la raíz (`tu-dominio.com`): registro **A** `76.76.21.21` (confirma el valor en Vercel) y `www` → CNAME + redirección.
   - Si el DNS está en Cloudflare, deja esos registros en **«solo DNS» (nube gris)** para que Vercel emita el certificado.
2. Espera a que Vercel marque el dominio como válido: el **HTTPS (Let's Encrypt) se activa solo**. HSTS ya lo envía la aplicación
   (2 años): **no lo prepares para la lista de precarga hasta estar seguro** de que todo el dominio irá siempre por HTTPS.
3. Comprueba con `curl -I https://drive.tu-dominio.com/login`: `strict-transport-security`, `content-security-policy` y `x-frame-options`.
   Pasa el dominio por **securityheaders.com** y **ssllabs.com/ssltest** y anota la nota en `docs/LANZAMIENTO.md`.

## 5. Correo: SPF, DKIM y DMARC (que las invitaciones no caigan en spam)

1. En **Resend → Domains**, añade `tu-dominio.com` (o un subdominio `mail.tu-dominio.com`, más limpio) y crea en tu DNS los registros que
   te muestre, **tal cual**:
   - **SPF**: TXT en el subdominio de envío con `v=spf1 include:amazonses.com ~all` (Resend usa Amazon SES; copia el valor que Resend indique).
   - **DKIM**: CNAME/TXT `resend._domainkey…` (Resend te da el valor).
   - **MX** del subdominio de envío (para rebotes), según Resend.
2. **DMARC** (en `_dmarc.tu-dominio.com`, TXT), empezando en modo observación:
   `v=DMARC1; p=none; rua=mailto:dmarc@tu-dominio.com; adkim=s; aspf=s`. Tras 2–4 semanas sin problemas, sube a `p=quarantine` y luego `p=reject`.
3. Espera a que Resend marque el dominio como **Verified** y pon `MAIL_FROM="MLS Drive <avisos@tu-dominio.com>"`.
4. Prueba: **`/admin/estado` → «Enviar correo de prueba»** y una invitación real a una cuenta de Gmail y otra de Outlook; abre
   «Mostrar original» y comprueba `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`. Usa mail-tester.com para la puntuación.

## 6. Migraciones: procedimiento seguro

1. **Copia previa**: `npm run backup-db` (o descarga un backup de Supabase) **antes** de tocar nada. Anota la hora.
2. **Prueba en el entorno de pruebas** con una copia reciente de producción (`docs/BACKUPS.md` §2).
3. **Aplica** el fichero nuevo (`supabase/migrations/00NN_….sql`) en el SQL Editor de producción. Son idempotentes: si se corta, se
   vuelve a ejecutar entero. Para cambios con riesgo, usa una transacción (`begin; … commit;`) y revisa antes de confirmar.
4. **Verifica**: `npm run seed-prod -- --check`, `/admin/estado`, y la batería de `supabase/tests/*.sql` en pruebas.
5. **Despliega** el código que la usa (primero la migración, después el código, salvo que el código nuevo sea compatible con
   ambas). Las migraciones del proyecto son **aditivas** (tablas/columnas/funciones nuevas), así que el código viejo sigue funcionando.
6. **Revertir**: (a) si el código nuevo falla, vuelve al despliegue anterior en Vercel (*Promote* del anterior): la migración aditiva no
   lo rompe; (b) si la migración es la culpable, restaura la copia previa (`docs/BACKUPS.md` §2) o escribe una migración inversa
   revisada. **Nunca** borres columnas o tablas en la misma entrega que el código que dejó de usarlas: hazlo una entrega después.

## 7. CI y tareas programadas

- `.github/workflows/ci.yml`: en **cada push y pull request** ejecuta `typecheck`, `lint`, `test`, `build`, `npm audit` (producción,
  alta/crítica) y la comprobación de que el JS del cliente no lleva secretos. **Protege `main`** (Settings → Branches → Branch
  protection): exige que `CI / verify` esté en verde y prohíbe el push directo; así solo se despliega a producción lo que pasa.
- `.github/workflows/backups.yml`: copias diarias (`docs/BACKUPS.md`).
- `.github/workflows/cron.yml`: avisos y estado cada ~15 min y el resumen diario. Secretos: `SITE_URL`, `CRON_SECRET`.

## 8. Planes y uso comercial (verifica las condiciones y tarifas vigentes: cambian)

| Servicio | Plan gratuito | Límites que importan | Cuándo pasar a pago |
| --- | --- | --- | --- |
| **Vercel** | *Hobby*: **uso personal y no comercial** (sus términos prohíben el uso comercial) | Cron solo 1 vez al día; límites de funciones/ancho de banda | **Desde el primer cliente o ingreso: Pro** (~20 USD por miembro al mes). No lo uses comercialmente en Hobby |
| **Supabase** | *Free*: 500 MB de BD, **proyecto en pausa tras ~1 semana sin actividad**, sin backups descargables | 50 000 usuarios activos/mes, límites de correo de Auth | **Antes de lanzar: Pro** (~25 USD/mes): sin pausa, backups diarios, más recursos |
| **Cloudflare R2** | 10 GB-mes gratis y 1 M de operaciones de escritura / 10 M de lectura al mes | Sin coste de salida | Se paga por uso al pasar los 10 GB (~0,015 USD/GB-mes) |
| **Resend** | 100 correos/día y 3 000/mes, 1 dominio | Suficiente para un equipo pequeño | Si los resúmenes y avisos superan el límite (Pro ~20 USD/mes) |
| **GitHub Actions** | 2 000 min/mes en repos privados | La CI + copias + cron cada 15 min consumen ~1 000–1 500 min/mes | Si te quedas sin minutos: pasa el cron a Vercel Pro o a un cron externo |

Orden recomendado de arranque: **Supabase Pro + Vercel Pro + R2 de pago por uso + Resend gratis** (~45–50 USD/mes + el
almacenamiento) en cuanto haya clientes o datos que no puedas perder.

## 9. Checklist de configuración (marca al hacerlo)

- [ ] Supabase prod: migraciones 0001–0010 · registro público **desactivado** · Site URL y redirect · plantillas · SMTP · owner creado
- [ ] R2 prod: 2 buckets privados · 2 tokens · CORS solo del dominio · bucket de copia en otra cuenta
- [ ] Vercel: rama `main` · variables (sensibles) · dominio · `www` redirigido · HTTPS activo
- [ ] DNS: CNAME/A · SPF · DKIM · DMARC (`p=none`) · Resend «Verified»
- [ ] GitHub: `ci.yml` en verde · protección de `main` · secretos de `backups.yml` y `cron.yml`
- [ ] `/admin/estado`: todo «Correcto» · correo de prueba recibido · primera copia hecha y **restaurada en pruebas**
- [ ] securityheaders.com y SSL Labs: anotadas las notas · Lighthouse de las pantallas clave (`docs/RENDIMIENTO.md`)
