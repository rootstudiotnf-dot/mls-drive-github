# Vault: bucket propio, token, desbloqueo y copia de seguridad

El Vault guarda el material original o sin publicar con el acceso más estricto de la plataforma. Su almacenamiento
está **separado**: otro bucket privado y otro token de API. Esta guía sirve para dejarlo funcionando.

## 1. Crear el bucket del Vault

1. Cloudflare → **R2** → **Create bucket**. Nombre, por ejemplo, `mls-drive-vault`. Déjalo **privado** (sin dominio
   público ni `r2.dev`).
2. Región: la misma que el bucket principal (o automática).

## 2. Token de API solo para ese bucket

1. R2 → **Manage API tokens** → **Create API token**.
2. Permisos: **Object Read & Write**. En *Specify bucket(s)* elige **solo** `mls-drive-vault`.
3. Copia el *Access Key ID* y el *Secret Access Key* (solo se muestran una vez).
4. El token del bucket principal debe seguir limitado a **su** bucket: ninguno de los dos tokens abre el bucket del
   otro. Compruébalo con cualquier cliente S3: con el token del Vault, listar el bucket principal debe dar
   «Access Denied», y al revés.

## 3. Variables de entorno (solo servidor)

```
R2_VAULT_BUCKET=mls-drive-vault
R2_VAULT_ACCESS_KEY_ID=...
R2_VAULT_SECRET_ACCESS_KEY=...
VAULT_COOKIE_SECRET=<al menos 32 caracteres aleatorios>
```

`R2_ACCOUNT_ID` es el mismo de siempre. Genera el secreto con `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
Sin estas variables el Vault falla cerrado: el owner ve «Vault sin configurar» y nadie más lo ve.

## 4. CORS del bucket del Vault

Mismo criterio que el bucket principal (el navegador sube y descarga directamente con URLs prefirmadas) y, además,
**lectura con `Range`** porque «Mover al Vault» y «Sacar del Vault» copian parte a parte desde el navegador:

```json
[
  {
    "AllowedOrigins": ["https://TU-DOMINIO"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range"],
    "MaxAgeSeconds": 3600
  }
]
```

El **bucket principal** necesita también `GET` con `Range` permitido (para que el navegador lea el original al moverlo
al Vault) y `ExposeHeaders` con `Content-Range`.

## 5. Ciclo de vida: multipart incompleto

En el bucket del Vault (y en el principal): **Settings → Object lifecycle rules → Add rule** → *Abort incomplete
multipart uploads* a los **1 día**. Así una subida o un movimiento interrumpido no deja partes huérfanas facturándose.

## 6. Verificación en dos pasos

Cualquier persona con acceso al Vault necesita TOTP: se activa en **/cuenta/seguridad** (QR, código de 6 dígitos y
códigos de recuperación que se muestran **una sola vez**; solo se guarda su hash). En Supabase Auth, **MFA (TOTP)** debe
estar habilitado (Authentication → Sign In / Providers → Multi-Factor).

## 7. Cómo funciona el desbloqueo

- Al abrir `/vault` se pide de nuevo la contraseña (se verifica en un cliente aparte: no sustituye tu sesión) y, si la
  sesión no es `aal2`, el código TOTP.
- Se emite la cookie `vault_unlock` (HttpOnly, SameSite=Strict, firmada con `VAULT_COOKIE_SECRET`, ligada a tu persona y
  a tu sesión): **15 minutos** con renovación por actividad, **máximo 2 horas**.
- 5 fallos seguidos → bloqueo de 15 minutos.
- Ver: URL de 2 minutos. Descargar: 60 segundos, máximo 50 al día por persona. No hay ZIP ni descargas en lote.
- Cada apertura, listado, vista previa, descarga, subida, movimiento, papelera y cambio de acceso se registra **antes**
  de devolver nada (si el registro falla, se deniega). El owner lo ve completo en `/vault/registro` y lo exporta a CSV.

## 8. Copia de seguridad (opcional)

`npm run backup-vault` copia al bucket de copia los objetos **nuevos o modificados** del Vault y deja constancia en el
registro (`backup.vault`). Variables:

```
R2_BACKUP_BUCKET=...
R2_BACKUP_ENDPOINT=https://<cuenta-o-proveedor>/...
R2_BACKUP_ACCESS_KEY_ID=...
R2_BACKUP_SECRET_ACCESS_KEY=...
```

Pon el bucket de copia en **otra cuenta o proveedor**. Sin `R2_BACKUP_BUCKET` el script lo indica y termina sin error.
`-- --dry-run` solo muestra qué copiaría.

**Programarlo.** Una vez al día basta, por ejemplo con cron (`0 3 * * *  cd /ruta && npm run backup-vault`), con el
Programador de tareas de Windows o con una tarea programada de tu proveedor. Se puede repetir sin riesgo.

**Coste.** Duplica el almacenamiento **solo del Vault**. Ejemplo: 200 GB en el Vault son otros 200 GB en la copia; a
0,015 USD/GB·mes (R2) son unos 3 USD/mes más, sin coste de salida (egress) si la copia también está en R2. En otro
proveedor, aplica su tarifa. `/almacenamiento` muestra el uso y el coste del Vault como línea aparte.

## 9. Limpieza programada

`npm run purge-trash -- --yes` también limpia el Vault: papelera de más de 30 días (con el bucket y token del Vault),
objetos huérfanos que dejó un movimiento entre buckets y movimientos abandonados.

## Limitaciones conocidas

- Al **sacar** un archivo del Vault no se regeneran miniaturas ni versiones web de las fotos (el Vault no guarda
  derivados); los vídeos sí se vuelven a procesar. Las fotos mostrarán un marcador hasta que se vuelvan a procesar.
- Los formatos admitidos son los de la lista cerrada de la plataforma (fotos incl. RAW, vídeo, audio, PDF, DOCX, XLSX,
  PPTX, TXT y ZIP). Los «archivos de proyecto» de otras aplicaciones se guardan comprimidos en `.zip`.
