# Servicio de procesado de vídeo (`services/transcoder`)

Genera, para cada vídeo subido, una **copia ligera** (proxy H.264 1080p con `faststart`) y un **póster** JPEG. El
original no se toca. Es un servidor HTTP de Node (solo librería estándar) más `ffmpeg` del sistema.

## Cómo encaja

```
navegador ──sube──▶ R2 (original)
web (Vercel) ── POST /transcode (firmado HMAC + URLs prefirmadas 1 h) ──▶ transcoder
transcoder ── GET original / PUT proxy / PUT póster (URLs prefirmadas) ──▶ R2
transcoder ── POST /api/internal/video-callback (firmado HMAC) ──▶ web
```

- **El servicio no tiene credenciales de R2.** Recibe de la web URLs prefirmadas de **1 hora** válidas solo para las
  tres claves concretas. Arranca en negativo si en su entorno hay variables que parezcan claves de almacenamiento
  (`R2_*`, `AWS_*`, `S3_*`, `*ACCESS_KEY*`, `*SERVICE_ROLE*`).
- Solo habla con los hosts de `ALLOWED_HOSTS` (R2) y `CALLBACK_HOSTS` (la web); solo `https`.
- Cada petición va firmada: `HMAC-SHA256(secreto, timestamp.nonce.cuerpo)`; se rechaza si la marca difiere más de
  5 min, si el nonce ya se usó o si la firma no coincide (comparación en tiempo constante). Lo mismo, en sentido
  contrario, para el callback.
- Un solo trabajo a la vez (`MAX_CONCURRENT`); si está ocupado responde 503 y el trabajo sigue en cola. Idempotente por
  `jobId`. `ffmpeg` se ejecuta con `spawn` y argumentos en array, con temporizador de seguridad, y los temporales se
  borran siempre.

## Variables

**Servicio** (`services/transcoder`):

| Variable | Descripción |
| --- | --- |
| `TRANSCODER_HMAC_SECRET` | Secreto compartido con la web (mínimo 32 caracteres, aleatorio) |
| `ALLOWED_HOSTS` | Host(s) de R2, p. ej. `<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `CALLBACK_HOSTS` | Host de la web, p. ej. `drive.tudominio.com` |
| `PORT` | Por defecto 8080 |
| `MAX_CONCURRENT` | Trabajos a la vez (por defecto 1) |
| `JOB_TIMEOUT_MIN` | Tiempo máximo por trabajo (por defecto 240) |

**Web** (solo servidor, `.env.local` / Vercel): `TRANSCODER_URL`, `TRANSCODER_HMAC_SECRET` (el mismo) y
`VIDEO_MAX_DURATION_MIN` (120 por defecto).

## Máquina recomendada

Procesar es CPU: **4 vCPU y 4 GB de RAM** da ~1× a 2× tiempo real en 1080p con `veryfast`. Disco temporal ≥ 2 × el vídeo
más grande (un original de 20 GB necesita ~45 GB). Para vídeos pequeños bastan 2 vCPU / 2 GB.

## Despliegue en Fly.io (se apaga cuando no hay trabajo)

```bash
cd services/transcoder
fly launch --no-deploy --name mls-transcoder --region mad
fly secrets set TRANSCODER_HMAC_SECRET="$(openssl rand -hex 32)" \
  ALLOWED_HOSTS="<ACCOUNT_ID>.r2.cloudflarestorage.com" CALLBACK_HOSTS="drive.tudominio.com"
```

En `fly.toml`: `internal_port = 8080`, `auto_stop_machines = "stop"`, `auto_start_machines = true`,
`min_machines_running = 0` y `[[vm]] size = "performance-4x"` (o `shared-cpu-4x` con 4 GB). Después `fly deploy`.
Fly arranca la máquina con la primera petición de la web (tarda unos segundos; si no responde a tiempo el trabajo queda
en cola y lo recupera el script de reintento). Copia la URL (`https://mls-transcoder.fly.dev`) en `TRANSCODER_URL`.

## Alternativa: Google Cloud Run

```bash
gcloud run deploy mls-transcoder --source services/transcoder --region europe-west1 \
  --cpu 4 --memory 4Gi --concurrency 1 --timeout 3600 --min-instances 0 --max-instances 2 \
  --set-env-vars ALLOWED_HOSTS=<ACCOUNT_ID>.r2.cloudflarestorage.com,CALLBACK_HOSTS=drive.tudominio.com \
  --set-secrets TRANSCODER_HMAC_SECRET=transcoder-hmac:latest --allow-unauthenticated
```

`--allow-unauthenticated` es correcto: la autenticación es la firma HMAC de cada petición. Con CPU «solo durante
peticiones» el trabajo debe terminar dentro de la petición; activa **CPU siempre asignada** (`--no-cpu-throttling`)
porque el procesado continúa tras responder 202.

## Reintentos

Ejecuta `npm run requeue-media-jobs` desde un cron cada 10–15 minutos. Reenvía los trabajos `queued` o `processing`
con más de 30 minutos (máximo 3 intentos; después quedan `failed`). El script **no necesita credenciales de R2**: llama a
`/api/internal/video-requeue` firmando con el secreto, y es la web quien genera las URLs. También se puede
«Reprocesar» un vídeo a mano (owner/admin) desde su página.

## Probarlo en local con Docker

```bash
docker build -t mls-transcoder services/transcoder
docker run --rm -p 8080:8080 \
  -e TRANSCODER_HMAC_SECRET="$(openssl rand -hex 32)" \
  -e ALLOWED_HOSTS=<host-de-r2> -e CALLBACK_HOSTS=localhost:3000 \
  mls-transcoder
curl http://localhost:8080/health
```

Para desarrollo sin HTTPS (R2 local/MinIO y `http://localhost:3000`) añade `-e ALLOW_INSECURE_HTTP=1`
(nunca en producción).

## Probarlo sin Docker

Con Node 22+ y `ffmpeg`/`ffprobe` en el PATH:

```bash
cd services/transcoder && npm test
```

Genera vídeos de prueba con `ffmpeg` (H.264, vertical con rotación, HDR HLG, 1440p), los procesa de verdad contra un
«R2» y una «web» falsos y comprueba el resultado y la seguridad (firmas, marcas antiguas, nonces repetidos, SSRF,
idempotencia, límites y el rechazo de credenciales en el entorno).

## Audio de los beats (Fase 7)

El mismo servicio procesa los beats (`type: "audio"`): genera un **preview MP3 a 160 kbps** sin metadatos del original,
mide la duración, la frecuencia y los canales, y calcula **~800 picos** para la forma de onda leyendo el audio en
streaming (un WAV de 10 minutos no se carga entero en memoria). Si el beat lo pide, mezcla el **tag de voz** del
propietario cada N segundos (el tag debe durar al menos ~1,5 s). El callback firmado deja el derivado `audio_preview`,
la duración y la forma de onda; hasta que el trabajo termina el beat no se puede publicar.

- Reintentar trabajos en cola: `npm run requeue-media-jobs` (vídeo y audio; antes `requeue-video-jobs`).
- «Reprocesar preview» en la ficha del beat (quien puede publicar) vuelve a encolar el trabajo.
