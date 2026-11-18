// Servicio de procesado de vídeo. Solo librería estándar de Node + ffmpeg/ffprobe del sistema.
//
//   POST /transcode   (firmada con HMAC, ver signing.mjs)
//   GET  /health
//
// NO tiene credenciales de almacenamiento: lee el original y escribe el proxy y el póster con URLs prefirmadas
// de corta vida que le entrega la web, y solo contacta con los hosts permitidos (ALLOWED_HOSTS para R2,
// CALLBACK_HOSTS para la web). Arranca en negativo si en su entorno hay variables que parezcan claves de R2/S3.
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NonceStore, signedHeaders, verify } from "./signing.mjs";

const env = process.env;

// --- Configuración ---------------------------------------------------------------------------------
const PORT = Number(env.PORT ?? 8080);
const SECRET = env.TRANSCODER_HMAC_SECRET ?? "";
const ALLOWED_HOSTS = parseHosts(env.ALLOWED_HOSTS);
const CALLBACK_HOSTS = parseHosts(env.CALLBACK_HOSTS);
const MAX_CONCURRENT = Math.max(1, Number(env.MAX_CONCURRENT ?? 1));
const JOB_TIMEOUT_MS = Math.max(1, Number(env.JOB_TIMEOUT_MIN ?? 240)) * 60 * 1000;
const FFMPEG = env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = env.FFPROBE_PATH ?? "ffprobe";
const ALLOW_HTTP = env.ALLOW_INSECURE_HTTP === "1"; // solo para pruebas locales (R2 y la web usan https)
const MAX_BODY_BYTES = 64 * 1024;

function parseHosts(value) {
  return new Set(String(value ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}

/** El servicio no debe tener claves de almacenamiento: si las ve en su entorno, se niega a arrancar. */
export function forbiddenEnvNames(environment) {
  return Object.keys(environment).filter((name) => /^(R2_|AWS_|S3_|CLOUDFLARE_)/i.test(name) || /(ACCESS_KEY|SECRET_ACCESS|SERVICE_ROLE)/i.test(name));
}

// --- Validación de URLs (evita que alguien le haga leer/escribir en hosts internos) -------------------------------
export function checkUrl(value, allowed, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return `${label}: URL no válida`;
  }
  if (url.protocol !== "https:" && !(ALLOW_HTTP && url.protocol === "http:")) return `${label}: solo https`;
  if (url.username || url.password) return `${label}: sin credenciales en la URL`;
  if (!allowed.has(url.host.toLowerCase()) && !allowed.has(url.hostname.toLowerCase())) return `${label}: host no permitido`;
  return null;
}

// --- Estado ----------------------------------------------------------------------------------------------------
const nonces = new NonceStore();
/** jobId → 'running' | 'done' (idempotencia por jobId) */
const jobs = new Map();
let running = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// --- Utilidades de procesos y red -----------------------------------------------------------------------------------
function run(command, args, { timeoutMs, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    // spawn con argumentos en array: nada se interpreta en un shell
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString().slice(0, 1_000_000)));
    child.stderr.on("data", (c) => (stderr = (stderr + c.toString()).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs ?? JOB_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(signal === "SIGKILL" ? "Tiempo agotado procesando el vídeo" : `${path.basename(command)} terminó con código ${code}: ${stderr.trim().split("\n").pop() ?? ""}`));
    });
  });
}

function transportFor(url) {
  return url.protocol === "https:" ? https : http;
}

/** GET en streaming a un archivo, con límite de tamaño. Sin redirecciones. */
function download(sourceUrl, destination, maxBytes) {
  return new Promise((resolve, reject) => {
    const url = new URL(sourceUrl);
    const request = transportFor(url).get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`El almacenamiento respondió ${response.statusCode} al leer el original`));
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (maxBytes && declared > maxBytes) {
        response.resume();
        return reject(new Error("El vídeo supera el tamaño máximo permitido"));
      }
      let received = 0;
      const out = fs.createWriteStream(destination);
      response.on("data", (chunk) => {
        received += chunk.length;
        if (maxBytes && received > maxBytes) {
          request.destroy(new Error("El vídeo supera el tamaño máximo permitido"));
          out.destroy();
        }
      });
      response.pipe(out);
      out.on("finish", () => resolve(received));
      out.on("error", reject);
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(120_000, () => request.destroy(new Error("Tiempo agotado leyendo el original")));
  });
}

/** PUT de un archivo con Content-Length (lo exige S3/R2). */
async function upload(putUrl, file, contentType) {
  const { size } = await fsp.stat(file);
  await new Promise((resolve, reject) => {
    const url = new URL(putUrl);
    const request = transportFor(url).request(url, { method: "PUT", headers: { "content-type": contentType, "content-length": size } }, (response) => {
      response.resume();
      response.on("end", () => (response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new Error(`El almacenamiento rechazó la subida (${response.statusCode})`))));
    });
    request.on("error", reject);
    fs.createReadStream(file).pipe(request);
  });
  return size;
}

async function postCallback(callbackUrl, payload) {
  const body = JSON.stringify(payload);
  const headers = { "content-type": "application/json", ...signedHeaders(SECRET, body) };
  const url = new URL(callbackUrl);
  await new Promise((resolve, reject) => {
    const request = transportFor(url).request(url, { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (response) => {
      response.resume();
      response.on("end", () => (response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new Error(`callback ${response.statusCode}`))));
    });
    request.on("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error("callback: tiempo agotado")));
    request.end(body);
  });
}

// --- ffprobe y ffmpeg -------------------------------------------------------------------------------------------------
function parseFps(value) {
  const [n, d] = String(value ?? "0/1").split("/").map(Number);
  return d ? Math.round((n / d) * 1000) / 1000 : 0;
}

export function readProbe(json) {
  const video = (json.streams ?? []).find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic));
  if (!video) throw new Error("El archivo no contiene vídeo");
  const rotationTag = Number(video.tags?.rotate ?? 0);
  const matrix = (video.side_data_list ?? []).find((d) => d.rotation !== undefined);
  const rotation = ((Math.round(Number(matrix?.rotation ?? rotationTag)) % 360) + 360) % 360;
  const transfer = String(video.color_transfer ?? "");
  const hdr = transfer === "smpte2084" || transfer === "arib-std-b67";
  const duration = Number(json.format?.duration ?? video.duration ?? 0);
  return {
    duration,
    width: Number(video.width),
    height: Number(video.height),
    fps: parseFps(video.avg_frame_rate !== "0/0" ? video.avg_frame_rate : video.r_frame_rate),
    codec: String(video.codec_name ?? ""),
    rotation,
    hdr,
    transfer: transfer || null,
    bitrate: Number(json.format?.bit_rate ?? video.bit_rate ?? 0),
    hasAudio: (json.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

/** Filtro de vídeo del proxy: HDR → SDR (bt709) y escalado a 1080p como máximo manteniendo la proporción. */
export function buildVideoFilter(info) {
  const scale = "scale=w='if(gte(iw,ih),-2,min(1080,iw))':h='if(gte(iw,ih),min(1080,ih),-2)':flags=lanczos";
  if (!info.hdr) return `${scale},format=yuv420p`;
  // Conversión tonal: lineal → BT.709 con tonemap «hable»; colores correctos en lugar de apagados
  return [scale, "zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv", "format=yuv420p"].join(",");
}

export function buildProxyArgs(input, output, info) {
  return [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", buildVideoFilter(info),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart",
    "-max_muxing_queue_size", "2048",
    output,
  ];
}

export function buildPosterArgs(input, output, seconds) {
  return [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", seconds.toFixed(3), "-i", input,
    "-frames:v", "1", "-vf", "scale=w='min(1280,iw)':h=-2", "-q:v", "3",
    output,
  ];
}

// --- Audio: preview MP3 160 kbps (con tag de voz opcional) + picos de la forma de onda ---------------------------------

export const WAVEFORM_POINTS = 800;
const MAX_TAG_COPIES = 120;

/**
 * Acumula picos de PCM s16le mono en N cubos sin guardar el audio (memoria constante, vale para horas de audio).
 * `totalSamples` es la estimación (duración × frecuencia); lo que sobre cae en el último cubo.
 */
export class PeakAccumulator {
  constructor(totalSamples, points = WAVEFORM_POINTS) {
    this.points = points;
    this.size = Math.max(1, Math.ceil(totalSamples / points));
    this.peaks = new Array(points).fill(0);
    this.index = 0; // muestra global
    this.carry = null; // byte suelto entre trozos
  }
  push(chunk) {
    let buffer = chunk;
    if (this.carry !== null) buffer = Buffer.concat([Buffer.from([this.carry]), chunk]);
    const even = buffer.length - (buffer.length % 2);
    this.carry = buffer.length % 2 ? buffer[buffer.length - 1] : null;
    for (let i = 0; i < even; i += 2) {
      const value = Math.abs(buffer.readInt16LE(i));
      const bucket = Math.min(this.points - 1, Math.floor(this.index / this.size));
      if (value > this.peaks[bucket]) this.peaks[bucket] = value;
      this.index++;
    }
  }
  /** Picos normalizados a 0-255 (el más alto = 255). */
  result() {
    let max = 1;
    for (const p of this.peaks) if (p > max) max = p;
    return this.peaks.map((p) => Math.round((p / max) * 255));
  }
}

/** Filtro que mezcla el tag de voz cada N segundos (sin superar el nivel). Entrada 0 = canción, entrada 1 = tag. */
export function buildTagFilter(duration, intervalS) {
  const spacing = Math.max(5, intervalS, duration / MAX_TAG_COPIES);
  const times = [];
  for (let t = spacing; t < duration - 1; t += spacing) times.push(Math.round(t * 1000));
  if (times.length === 0) return null;
  const labels = times.map((_, i) => `[t${i}]`);
  const parts = [
    // loudnorm suave SOLO sobre el tag
    "[1:a]loudnorm=I=-20:TP=-2:LRA=7,aformat=sample_rates=44100:channel_layouts=stereo,volume=0.85" + (times.length > 1 ? `,asplit=${times.length}${labels.join("")}` : "[t0]"),
    ...times.map((ms, i) => `[t${i}]adelay=${ms}|${ms}[d${i}]`),
    "[0:a]aformat=sample_rates=44100:channel_layouts=stereo[main]",
    `[main]${times.map((_, i) => `[d${i}]`).join("")}amix=inputs=${times.length + 1}:normalize=0:duration=first,alimiter=limit=0.95[out]`,
  ];
  return { filter: parts.join(";"), copies: times.length };
}

export function buildAudioArgs(input, tagInput, output, duration, intervalS) {
  const base = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", input];
  const encode = ["-vn", "-c:a", "libmp3lame", "-b:a", "160k", "-ar", "44100", "-ac", "2", "-map_metadata", "-1", "-id3v2_version", "0", "-write_id3v1", "0", output];
  const tag = tagInput ? buildTagFilter(duration, intervalS) : null;
  if (tag) return [...base, "-i", tagInput, "-filter_complex", tag.filter, "-map", "[out]", ...encode];
  return [...base, "-map", "0:a:0", ...encode];
}

export function readAudioProbe(json) {
  const audio = (json.streams ?? []).find((s) => s.codec_type === "audio");
  if (!audio) throw new Error("El archivo no contiene audio");
  return {
    duration: Number(json.format?.duration ?? audio.duration ?? 0),
    sampleRate: Number(audio.sample_rate ?? 0),
    channels: Number(audio.channels ?? 0),
    codec: String(audio.codec_name ?? ""),
  };
}

/** PCM mono 8 kHz por la salida estándar de ffmpeg, procesado en streaming (nunca se guarda todo en memoria). */
function waveform(input, duration) {
  return new Promise((resolve, reject) => {
    const accumulator = new PeakAccumulator(Math.max(1, Math.round(duration * 8000)));
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", input, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), JOB_TIMEOUT_MS);
    let stderr = "";
    child.stdout.on("data", (c) => accumulator.push(c));
    child.stderr.on("data", (c) => (stderr = (stderr + c.toString()).slice(-2000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(accumulator.result());
      else reject(new Error("No se pudo calcular la forma de onda: " + (stderr.trim().split("\n").pop() ?? "")));
    });
  });
}

async function processAudio(job) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "transcode-a-"));
  const started = Date.now();
  try {
    const source = path.join(dir, "original");
    const tagFile = path.join(dir, "tag");
    const preview = path.join(dir, "preview.mp3");
    const limits = job.limits ?? {};
    await download(job.sourceUrl, source, Number(limits.maxBytes) || 0);
    const info = readAudioProbe(JSON.parse((await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", source], { timeoutMs: 120_000 })).stdout));
    if (limits.maxDurationSec && info.duration > Number(limits.maxDurationSec)) throw new Error("El audio supera la duración máxima permitida");

    let tagged = false;
    if (job.voiceTagUrl) {
      await download(job.voiceTagUrl, tagFile, 20 * 1024 * 1024);
      tagged = true;
    }
    if (tagged) log("tag de voz", job.jobId, `${(await fsp.stat(tagFile)).size} bytes`);
    await run(FFMPEG, buildAudioArgs(source, tagged ? tagFile : null, preview, info.duration, Number(job.voiceTagIntervalS) || 25));
    const peaks = await waveform(source, info.duration);
    const previewBytes = await upload(job.previewPutUrl, preview, "audio/mpeg");
    await postCallback(job.callbackUrl, {
      jobId: job.jobId, type: "audio", ok: true, peaks, previewBytes, tagged,
      meta: { duration: info.duration, sampleRate: info.sampleRate, channels: info.channels, codec: info.codec },
      seconds: Math.round((Date.now() - started) / 100) / 10,
    });
    log("audio listo", job.jobId, `${Math.round((Date.now() - started) / 1000)} s`);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 300);
    log("audio fallido", job.jobId, message);
    await postCallback(job.callbackUrl, { jobId: job.jobId, type: "audio", ok: false, error: message }).catch((e) => log("callback fallido", e.message));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function processJob(job) {
  if (job.type === "audio") return processAudio(job);
  return processVideoJob(job);
}

async function processVideoJob(job) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "transcode-"));
  const started = Date.now();
  try {
    const source = path.join(dir, "original");
    const proxy = path.join(dir, "proxy.mp4");
    const poster = path.join(dir, "poster.jpg");
    const limits = job.limits ?? {};
    await download(job.sourceUrl, source, Number(limits.maxBytes) || 0);

    const probe = JSON.parse((await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", source], { timeoutMs: 120_000 })).stdout);
    const info = readProbe(probe);
    if (limits.maxDurationSec && info.duration > Number(limits.maxDurationSec)) {
      throw new Error("El vídeo supera la duración máxima permitida");
    }

    await run(FFMPEG, buildProxyArgs(source, proxy, info));
    // El póster sale del proxy (ya en SDR y con la rotación aplicada), hacia el 10 % de la duración
    await run(FFMPEG, buildPosterArgs(proxy, poster, Math.max(0, info.duration * 0.1)), { timeoutMs: 120_000 });

    const [proxyBytes, posterBytes] = [await upload(job.proxyPutUrl, proxy, "video/mp4"), await upload(job.posterPutUrl, poster, "image/jpeg")];
    const portrait = info.rotation === 90 || info.rotation === 270;
    const meta = {
      codec: info.codec, fps: info.fps, rotation: info.rotation, hdr: info.hdr, bitrate: info.bitrate,
      width: portrait ? info.height : info.width, height: portrait ? info.width : info.height, duration: info.duration,
    };
    await postCallback(job.callbackUrl, { jobId: job.jobId, ok: true, meta, proxyBytes, posterBytes, seconds: Math.round((Date.now() - started) / 100) / 10 });
    log("trabajo listo", job.jobId, `${Math.round((Date.now() - started) / 1000)} s`);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 300);
    log("trabajo fallido", job.jobId, message);
    await postCallback(job.callbackUrl, { jobId: job.jobId, ok: false, error: message }).catch((e) => log("callback fallido", e.message));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined); // siempre se limpia
  }
}

// --- HTTP -------------------------------------------------------------------------------------------------------------------
function reply(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("cuerpo demasiado grande"));
        request.destroy();
      } else chunks.push(c);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function createServer() {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") return reply(response, 200, { ok: true, running });
      if (request.method !== "POST" || request.url !== "/transcode") return reply(response, 404, { error: "not found" });

      const body = await readBody(request);
      const verified = verify(SECRET, request.headers, body);
      if (!verified.ok) return reply(response, 401, { error: "firma no válida" });
      if (!nonces.use(verified.nonce)) return reply(response, 401, { error: "petición repetida" });

      let job;
      try {
        job = JSON.parse(body);
      } catch {
        return reply(response, 400, { error: "JSON no válido" });
      }
      if (typeof job?.jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(job.jobId)) return reply(response, 400, { error: "jobId no válido" });
      if (job.type !== undefined && job.type !== "video" && job.type !== "audio") return reply(response, 400, { error: "tipo de trabajo no válido" });
      const problem =
        checkUrl(job.sourceUrl, ALLOWED_HOSTS, "sourceUrl") ??
        (job.type === "audio"
          ? (checkUrl(job.previewPutUrl, ALLOWED_HOSTS, "previewPutUrl") ?? (job.voiceTagUrl ? checkUrl(job.voiceTagUrl, ALLOWED_HOSTS, "voiceTagUrl") : null))
          : (checkUrl(job.proxyPutUrl, ALLOWED_HOSTS, "proxyPutUrl") ?? checkUrl(job.posterPutUrl, ALLOWED_HOSTS, "posterPutUrl"))) ??
        checkUrl(job.callbackUrl, CALLBACK_HOSTS, "callbackUrl");
      if (problem) return reply(response, 400, { error: problem });

      // Idempotente por jobId: si ya se está procesando o terminó, no se repite
      if (jobs.has(job.jobId)) return reply(response, 202, { status: jobs.get(job.jobId) });
      if (running >= MAX_CONCURRENT) return reply(response, 503, { error: "ocupado" }, { "retry-after": "60" });

      jobs.set(job.jobId, "running");
      running++;
      reply(response, 202, { status: "running" });
      void processJob(job).finally(() => {
        running--;
        jobs.set(job.jobId, "done");
        // el registro de idempotencia no crece sin límite
        if (jobs.size > 500) for (const [id, state] of jobs) if (state === "done" && jobs.size > 400) jobs.delete(id);
      });
    } catch (error) {
      log("error de petición", error instanceof Error ? error.message : error);
      if (!response.headersSent) reply(response, 400, { error: "petición no válida" });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const bad = forbiddenEnvNames(env);
  if (bad.length > 0) {
    console.error(`Este servicio NO debe tener credenciales de almacenamiento. Variables prohibidas en el entorno: ${bad.join(", ")}`);
    process.exit(1);
  }
  if (SECRET.length < 32) {
    console.error("TRANSCODER_HMAC_SECRET debe tener al menos 32 caracteres.");
    process.exit(1);
  }
  if (ALLOWED_HOSTS.size === 0 || CALLBACK_HOSTS.size === 0) {
    console.error("Define ALLOWED_HOSTS (host de R2) y CALLBACK_HOSTS (host de la web).");
    process.exit(1);
  }
  createServer().listen(PORT, () => log(`transcoder escuchando en :${PORT}`));
}
