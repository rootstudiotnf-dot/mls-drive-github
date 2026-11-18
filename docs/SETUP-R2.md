# Puesta en marcha de Cloudflare R2 (Fase 3)

Los archivos **nunca pasan por el servidor de la web**: el navegador sube y descarga directamente contra R2
con URLs prefirmadas. El servidor solo comprueba permisos y firma.

## 1. Crear el bucket (privado)

1. En el panel de Cloudflare: **R2 → Create bucket**. Ponle un nombre (p. ej. `mls-drive`) y elige región cercana.
2. **No actives** el acceso público: ni *Public Development URL* (r2.dev) ni *Custom Domain*. El bucket debe quedar
   privado. (Comprobación al final: abrir la URL del objeto sin firmar debe dar **403**.)

## 2. Credenciales

1. **R2 → Manage R2 API Tokens → Create API token**.
2. Permisos: **Object Read & Write**. Restringe el token **a este bucket** (no a toda la cuenta).
3. Copia `Access Key ID` y `Secret Access Key` (el secreto solo se muestra una vez) y el **Account ID**.
4. Rellena en `.env.local` (guía completa de variables en `.env.example`):

   ```bash
   R2_ACCOUNT_ID=…
   R2_ACCESS_KEY_ID=…
   R2_SECRET_ACCESS_KEY=…        # SECRETA: solo servidor
   R2_BUCKET=mls-drive
   MAX_UPLOAD_GB=10
   UPLOAD_PART_SIZE_MB=16        # mínimo 5; partes más grandes = menos peticiones
   R2_PRICE_PER_GB_MONTH=0.015   # edítalo con la tarifa vigente de R2
   ```

Ninguna de estas variables lleva `NEXT_PUBLIC_`: no llegan al navegador.

## 3. CORS del bucket (imprescindible)

El navegador hace `PUT` directo a R2 desde tu dominio, así que el bucket debe permitirlo.
**Bucket → Settings → CORS Policy → Add** y pega:

```json
[
  {
    "AllowedOrigins": ["https://TU-DOMINIO", "http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

- **Solo** el origen de la web (y `http://localhost:3000` en desarrollo). No uses `*` como origen.
- `ExposeHeaders: ["ETag"]` es **imprescindible** para las subidas multipart: sin él el navegador no puede leer el ETag de cada parte.
- Si cambias de dominio, actualiza `AllowedOrigins`.

## 4. Regla de ciclo de vida (limpieza de subidas a medias)

Las subidas multipart que se abandonan dejan partes huérfanas que **se facturan**. Abórtalas automáticamente:

**Bucket → Settings → Object lifecycle rules → Add rule**

- *Rule name*: `abort-incomplete-multipart`
- *Apply to*: todos los objetos (sin prefijo)
- *Action*: **Abort incomplete multipart uploads** → **7 days**

(La aplicación además cancela en R2 las subidas que el usuario cancela y `purge-trash` limpia las abandonadas.)

## 5. Limpieza periódica (papelera y subidas abandonadas)

```bash
npm run purge-trash -- --dry-run   # muestra qué se borraría
npm run purge-trash -- --yes       # borra de forma definitiva
```

Borra los objetos de R2 y las filas de los assets en la papelera con **más de 30 días** y las subidas
`uploading` abandonadas con **más de 48 horas**. Es repetible. Prográmalo (cron diario, GitHub Actions,
Vercel Cron llamando a un runner…) con las mismas variables de entorno.

## 6. Base de datos

Aplica la migración `supabase/migrations/0003_storage.sql` (después de la 0001 y la 0002) y ejecuta
`supabase/tests/storage.sql` (debe terminar con `STORAGE OK`). Detalles en [SETUP-SUPABASE.md](SETUP-SUPABASE.md).

## 7. Comprobaciones tras configurar

1. `npm run dev` → entra como owner/admin → **Subir**: sube una foto pequeña (PUT simple) y un vídeo grande (multipart).
2. Abre el archivo en `/archivo/[id]`: la previsualización debe cargar (URL firmada de 5 minutos).
3. **Objeto sin firmar**: toma la URL de una imagen de la previsualización y quítale todo lo que sigue a `?`.
   Debe responder **403** (el bucket es privado).
4. Cierra la pestaña a mitad de una subida grande, vuelve a **Subir** y elige el mismo archivo: debe reanudar y
   enviar solo las partes que faltan.
5. `/almacenamiento` (administración): uso total, por tipo y por artista, y coste estimado.

## Límites y notas

- Subida simple hasta 50 MB; a partir de ahí, multipart con partes de `UPLOAD_PART_SIZE_MB` (máx. 10 000 partes;
  con partes de 16 MB caben ~160 GB).
- 4 partes en paralelo por archivo y 2 archivos a la vez. Las partes son `File.slice`: el archivo no se carga entero en memoria.
- Las URLs PUT valen solo para su clave y caducan en 15 minutos (1 hora las de parte). Las de ver duran 5 minutos y
  las de descargar 2.
- Probar en local sin R2: apunta `R2_ENDPOINT` a un S3 compatible (p. ej. MinIO) y usa sus credenciales en las
  variables `R2_*`. (`R2_ENDPOINT` es opcional y solo para desarrollo.)

## Problemas frecuentes

| Síntoma | Causa probable |
| --- | --- |
| La subida falla al instante con «network» | CORS no configurado o `AllowedOrigins` no incluye tu origen. |
| Las partes suben pero el cierre falla | Falta `ExposeHeaders: ["ETag"]` en el CORS. |
| `SignatureDoesNotMatch` | Hora del equipo muy desfasada, o credenciales de otro bucket/cuenta. |
| La previsualización devuelve 403 | La URL caducó (5 min): recarga la ficha. Si persiste, revisa el bucket y las credenciales. |
| Aparecen costes por «almacenamiento» sin archivos | Partes multipart huérfanas: revisa la regla de ciclo de vida del paso 4. |
