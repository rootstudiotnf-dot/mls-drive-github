// Pruebas del transcoder con ffmpeg REAL y un «R2» y una «web» falsos en local.
// Requiere ffmpeg y ffprobe en el PATH (la misma dependencia que el servicio).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { signedHeaders, verify, NonceStore } from "../signing.mjs";
import { buildProxyArgs, buildVideoFilter, checkUrl, forbiddenEnvNames, readProbe } from "../server.mjs";

const SECRET = "s".repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-test-"));
const stored = new Map(); // ruta → Buffer (lo que el servicio sube)
const callbacks = [];
let fake; // servidor de almacenamiento + callback
let fakePort;
let service;
let servicePort;

const ff = (args) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "pipe" });
const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]).toString());

function makeInputs() {
  const files = {};
  files.h264 = path.join(tmp, "h264.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", files.h264]);
  // vertical: sin rotar en bruto y con matriz de rotación de 90° (como un iPhone)
  const base = path.join(tmp, "rot-base.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", base]);
  files.rotated = path.join(tmp, "rotated.mp4");
  ff(["-display_rotation", "90", "-i", base, "-c", "copy", files.rotated]);
  // HDR (HLG, BT.2020, 10 bits, HEVC)
  files.hdr = path.join(tmp, "hdr.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=3", "-vf", "format=yuv420p10le", "-c:v", "libx265", "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc", "-tag:v", "hvc1", files.hdr]);
  // grande: 2560×1440 para comprobar el límite de 1080p
  files.big = path.join(tmp, "big.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=10:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", files.big]);
  return files;
}

let inputs;

before(async () => {
  inputs = makeInputs();
  fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname.startsWith("/orig/")) {
      const file = inputs[url.pathname.slice(6)];
      if (!file) return res.writeHead(404).end();
      const data = fs.readFileSync(file);
      return res.writeHead(200, { "content-length": data.length }).end(data);
    }
    if (req.method === "PUT") {
      stored.set(url.pathname, body);
      return res.writeHead(200).end();
    }
    if (req.method === "POST" && url.pathname === "/callback") {
      const check = verify(SECRET, req.headers, body.toString("utf8"));
      callbacks.push({ verified: check.ok, payload: JSON.parse(body.toString("utf8")) });
      return res.writeHead(200).end("{}");
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  fakePort = fake.address().port;
  servicePort = 20000 + Math.floor(Math.random() * 20000);
  service = spawn(process.execPath, [path.join(import.meta.dirname, "..", "server.mjs")], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
      TRANSCODER_HMAC_SECRET: SECRET, ALLOWED_HOSTS: `127.0.0.1:${fakePort}`, CALLBACK_HOSTS: `127.0.0.1:${fakePort}`,
      ALLOW_INSECURE_HTTP: "1", PORT: String(servicePort), MAX_CONCURRENT: "1",
    },
    stdio: process.env.TC_VERBOSE ? "inherit" : "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${servicePort}/health`)).ok) break; } catch { /* arrancando */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  service?.kill();
  fake?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (body, headers) => fetch(`http://127.0.0.1:${servicePort}/transcode`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
const jobBody = (jobId, name, extra = {}) =>
  JSON.stringify({
    jobId, sourceUrl: `http://127.0.0.1:${fakePort}/orig/${name}`, proxyPutUrl: `http://127.0.0.1:${fakePort}/proxy/${jobId}`,
    posterPutUrl: `http://127.0.0.1:${fakePort}/poster/${jobId}`, callbackUrl: `http://127.0.0.1:${fakePort}/callback`, limits: { maxDurationSec: 7200, maxBytes: 2_000_000_000 }, ...extra,
  });

async function transcode(name, extra) {
  const jobId = crypto.randomUUID();
  const body = jobBody(jobId, name, extra);
  const res = await post(body, signedHeaders(SECRET, body));
  assert.equal(res.status, 202);
  for (let i = 0; i < 300; i++) {
    const found = callbacks.find((c) => c.payload.jobId === jobId);
    if (found) return { jobId, callback: found };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sin callback");
}

function proxyFile(jobId) {
  const file = path.join(tmp, `proxy-${jobId}.mp4`);
  fs.writeFileSync(file, stored.get(`/proxy/${jobId}`));
  return file;
}

/** faststart: el átomo moov debe aparecer antes que mdat. */
function isFaststart(file) {
  const data = fs.readFileSync(file);
  const moov = data.indexOf("moov");
  const mdat = data.indexOf("mdat");
  return moov > 0 && mdat > 0 && moov < mdat;
}

test("H.264 normal: proxy H.264/AAC con faststart, póster JPEG y callback firmado con metadatos", async () => {
  const { jobId, callback } = await transcode("h264");
  assert.equal(callback.verified, true, "el callback va firmado");
  assert.equal(callback.payload.ok, true, callback.payload.error);
  const info = probe(proxyFile(jobId));
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  assert.equal(v.codec_name, "h264");
  assert.equal(v.pix_fmt, "yuv420p");
  assert.equal(a.codec_name, "aac");
  assert.ok(isFaststart(proxyFile(jobId)), "faststart (moov antes que mdat)");
  assert.equal(callback.payload.meta.codec, "h264");
  assert.equal(callback.payload.meta.width, 640);
  assert.ok(Math.abs(callback.payload.meta.duration - 4) < 0.5);
  assert.equal(callback.payload.meta.hdr, false);
  const poster = stored.get(`/poster/${jobId}`);
  assert.equal(poster[0], 0xff);
  assert.equal(poster[1], 0xd8);
  assert.equal(callback.payload.posterBytes, poster.length);
  assert.equal(callback.payload.proxyBytes, stored.get(`/proxy/${jobId}`).length);
});

test("vídeo de 1440p se reduce a 1080p máximo manteniendo la proporción", async () => {
  const { jobId, callback } = await transcode("big");
  assert.equal(callback.payload.ok, true, callback.payload.error);
  const v = probe(proxyFile(jobId)).streams.find((s) => s.codec_type === "video");
  assert.equal(v.height, 1080);
  assert.equal(v.width, 1920);
  const poster = stored.get(`/poster/${jobId}`);
  assert.ok(poster.length > 1000);
});

test("vertical con rotación (iPhone): el proxy sale ya rotado (alto > ancho) y los metadatos lo reflejan", async () => {
  const { jobId, callback } = await transcode("rotated");
  assert.equal(callback.payload.ok, true, callback.payload.error);
  assert.equal(callback.payload.meta.rotation, 90);
  const v = probe(proxyFile(jobId)).streams.find((s) => s.codec_type === "video");
  assert.ok(v.height > v.width, `vertical: ${v.width}x${v.height}`);
  assert.ok(callback.payload.meta.height > callback.payload.meta.width);
});

test("HDR (HLG, HEVC 10 bits): se detecta y el proxy sale en SDR BT.709 / yuv420p", async () => {
  const { jobId, callback } = await transcode("hdr");
  assert.equal(callback.payload.ok, true, callback.payload.error);
  assert.equal(callback.payload.meta.hdr, true);
  assert.equal(callback.payload.meta.codec, "hevc");
  const v = probe(proxyFile(jobId)).streams.find((s) => s.codec_type === "video");
  assert.equal(v.codec_name, "h264");
  assert.equal(v.pix_fmt, "yuv420p");
  assert.equal(v.color_transfer, "bt709");
  assert.equal(v.color_primaries, "bt709");
});

test("límites: un vídeo más largo que el máximo falla con mensaje corto y se informa en el callback", async () => {
  const { callback } = await transcode("h264", { limits: { maxDurationSec: 1, maxBytes: 2_000_000_000 } });
  assert.equal(callback.payload.ok, false);
  assert.match(callback.payload.error, /duración máxima/);
  assert.ok(callback.payload.error.length < 300);
});

test("límites: un original más grande que el máximo falla", async () => {
  const { callback } = await transcode("h264", { limits: { maxDurationSec: 7200, maxBytes: 1000 } });
  assert.equal(callback.payload.ok, false);
  assert.match(callback.payload.error, /tamaño máximo/);
});

test("original inexistente: falla y avisa, sin colgarse", async () => {
  const { callback } = await transcode("no-existe");
  assert.equal(callback.payload.ok, false);
});

test("seguridad: firma incorrecta, marca antigua, nonce repetido y cuerpo manipulado → 401", async () => {
  const id = crypto.randomUUID();
  const body = jobBody(id, "h264");
  assert.equal((await post(body, { ...signedHeaders(SECRET, body), "x-signature": "0".repeat(64) })).status, 401);
  assert.equal((await post(body, signedHeaders("otro-secreto-".repeat(4), body))).status, 401);
  assert.equal((await post(body, signedHeaders(SECRET, body, Date.now() - 6 * 60 * 1000))).status, 401, "marca de hace 6 min");
  assert.equal((await post(body, signedHeaders(SECRET, body, Date.now() + 6 * 60 * 1000))).status, 401, "marca del futuro");
  assert.equal((await post(body, {})).status, 401, "sin cabeceras");
  const headers = signedHeaders(SECRET, body);
  assert.equal((await post(body.replace("h264", "big"), headers)).status, 401, "cuerpo distinto al firmado");
  const ok = await post(body, headers);
  assert.equal(ok.status, 202);
  assert.equal((await post(body, headers)).status, 401, "el mismo nonce no se acepta dos veces");
});

test("seguridad: solo hosts permitidos (SSRF) y jobId válido", async () => {
  for (const [field, value] of [["sourceUrl", "http://169.254.169.254/latest/meta-data"], ["proxyPutUrl", "http://localhost:9/x"], ["callbackUrl", "http://evil.example/cb"], ["sourceUrl", "file:///etc/passwd"]]) {
    const body = JSON.stringify({ ...JSON.parse(jobBody(crypto.randomUUID(), "h264")), [field]: value });
    const res = await post(body, signedHeaders(SECRET, body));
    assert.equal(res.status, 400, `${field} = ${value}`);
  }
  const body = JSON.stringify({ ...JSON.parse(jobBody("no-es-uuid", "h264")) });
  assert.equal((await post(body, signedHeaders(SECRET, body))).status, 400);
});

async function idle() {
  for (let i = 0; i < 100; i++) {
    const health = await (await fetch(`http://127.0.0.1:${servicePort}/health`)).json();
    if (health.running === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("idempotente por jobId: repetir el trabajo (con nonce nuevo) no lo procesa otra vez", async () => {
  await idle(); // el trabajo aceptado en la prueba anterior aún puede estar en marcha (un solo trabajo a la vez)
  const jobId = crypto.randomUUID();
  const body = jobBody(jobId, "h264");
  assert.equal((await post(body, signedHeaders(SECRET, body))).status, 202);
  const again = await post(body, signedHeaders(SECRET, body)); // (con otro nonce)
  assert.equal(again.status, 202);
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(callbacks.filter((c) => c.payload.jobId === jobId).length, 1);
});

test("el servicio se niega a arrancar si su entorno tiene credenciales de almacenamiento", () => {
  assert.deepEqual(forbiddenEnvNames({ PATH: "x", TRANSCODER_HMAC_SECRET: "y" }), []);
  assert.deepEqual(forbiddenEnvNames({ R2_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", SUPABASE_SERVICE_ROLE_KEY: "c" }).length, 3);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "server.mjs")], {
    env: { PATH: process.env.PATH, R2_SECRET_ACCESS_KEY: "x", TRANSCODER_HMAC_SECRET: SECRET, ALLOWED_HOSTS: "a", CALLBACK_HOSTS: "b" },
    stdio: "ignore",
  });
  return new Promise((resolve) => child.on("exit", (code) => { assert.equal(code, 1); resolve(); }));
});

test("firma: compatible entre quien firma y quien verifica; NonceStore rechaza repeticiones", () => {
  const body = '{"a":1}';
  const h = signedHeaders(SECRET, body, 1_000_000_000_000);
  assert.equal(verify(SECRET, h, body, 1_000_000_000_000).ok, true);
  assert.equal(verify(SECRET, h, body + " ", 1_000_000_000_000).ok, false);
  const store = new NonceStore();
  assert.equal(store.use("abc", 0), true);
  assert.equal(store.use("abc", 1000), false);
  assert.equal(store.use("abc", 11 * 60 * 1000), true, "caduca pasado el TTL");
});

test("validación de URLs, lectura de ffprobe y construcción de argumentos (sin shell)", () => {
  const allowed = new Set(["r2.example.com"]);
  assert.equal(checkUrl("https://r2.example.com/x?y=1", allowed, "u"), null);
  assert.match(checkUrl("https://evil.com/x", allowed, "u"), /host no permitido/);
  assert.match(checkUrl("https://user:pw@r2.example.com/x", allowed, "u"), /credenciales/);
  assert.match(checkUrl("no es url", allowed, "u"), /no válida/);
  const info = readProbe({ format: { duration: "10", bit_rate: "100" }, streams: [{ codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, avg_frame_rate: "30000/1001", color_transfer: "arib-std-b67", side_data_list: [{ rotation: -90 }] }] });
  assert.equal(info.hdr, true);
  assert.equal(info.rotation, 270);
  assert.equal(info.fps, 29.97);
  assert.match(buildVideoFilter({ hdr: true }), /tonemap=tonemap=hable/);
  assert.match(buildVideoFilter({ hdr: true }), /zscale=t=bt709:m=bt709/);
  assert.doesNotMatch(buildVideoFilter({ hdr: false }), /tonemap/);
  const args = buildProxyArgs("in; rm -rf /", "out.mp4", { hdr: false });
  assert.ok(Array.isArray(args) && args.includes("in; rm -rf /"), "un nombre raro viaja como un único argumento");
  assert.ok(args.includes("+faststart") && args.includes("veryfast") && args.includes("23") && args.includes("128k"));
});

// ---------------------------------------------------------------------------
// Audio (Fase 7)
// ---------------------------------------------------------------------------
import { PeakAccumulator, buildAudioArgs, buildTagFilter, readAudioProbe } from "../server.mjs";

function makeAudio() {
  const files = {};
  files.wav = path.join(tmp, "beat.wav");
  ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=6:sample_rate=48000", "-ac", "2", files.wav]);
  files.mp3 = path.join(tmp, "beat.mp3");
  ff(["-f", "lavfi", "-i", "sine=frequency=330:duration=5", "-c:a", "libmp3lame", "-b:a", "192k", files.mp3]);
  files.silent = path.join(tmp, "silent.wav");
  ff(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "10", files.silent]);
  files.tag = path.join(tmp, "tag.wav");
  ff(["-f", "lavfi", "-i", "sine=frequency=1000:duration=1.5", files.tag]);
  files.long = path.join(tmp, "long.wav");
  ff(["-f", "lavfi", "-i", "sine=frequency=110:duration=600:sample_rate=44100", "-ac", "1", files.long]); // 10 minutos
  return files;
}

const audioBody = (jobId, name, extra = {}) =>
  JSON.stringify({
    type: "audio", jobId, sourceUrl: `http://127.0.0.1:${fakePort}/orig/${name}`, previewPutUrl: `http://127.0.0.1:${fakePort}/preview/${jobId}`,
    callbackUrl: `http://127.0.0.1:${fakePort}/callback`, limits: { maxDurationSec: 7200, maxBytes: 2_000_000_000 }, ...extra,
  });

async function transcodeAudio(name, extra) {
  await idle();
  const jobId = crypto.randomUUID();
  const body = audioBody(jobId, name, extra);
  const res = await post(body, signedHeaders(SECRET, body));
  assert.equal(res.status, 202);
  for (let i = 0; i < 600; i++) {
    const found = callbacks.find((c) => c.payload.jobId === jobId);
    if (found) return { jobId, callback: found };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sin callback de audio");
}

before(() => {
  Object.assign(inputs, makeAudio());
});

const previewFile = (jobId) => {
  const file = path.join(tmp, `preview-${jobId}.mp3`);
  fs.writeFileSync(file, stored.get(`/preview/${jobId}`));
  return file;
};

const maxVolume = (file, start) => {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(start), "-t", "0.4", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = /max_volume: (-?[0-9.]+) dB/.exec(res.stderr ?? "");
  return m ? Number(m[1]) : -91; // «-inf» o sin coincidencia = silencio
};

test("audio WAV: preview MP3 160 kbps estéreo 44,1 kHz, sin metadatos, con duración y 800 picos", async () => {
  const { jobId, callback } = await transcodeAudio("wav");
  assert.equal(callback.verified, true);
  assert.equal(callback.payload.ok, true, callback.payload.error);
  assert.equal(callback.payload.type, "audio");
  const file = previewFile(jobId);
  const info = probe(file);
  const a = info.streams.find((s) => s.codec_type === "audio");
  assert.equal(a.codec_name, "mp3");
  assert.equal(Number(a.sample_rate), 44100);
  assert.equal(a.channels, 2);
  assert.ok(Math.abs(Number(info.format.bit_rate) - 160000) < 8000, `bitrate ${info.format.bit_rate}`);
  assert.notEqual(fs.readFileSync(file).subarray(0, 3).toString(), "ID3", "sin cabecera ID3");
  assert.ok(Math.abs(callback.payload.meta.duration - 6) < 0.3);
  assert.equal(callback.payload.meta.sampleRate, 48000);
  assert.equal(callback.payload.meta.channels, 2);
  assert.equal(callback.payload.peaks.length, 800);
  assert.ok(callback.payload.peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 255));
  assert.equal(Math.max(...callback.payload.peaks), 255);
  assert.equal(callback.payload.previewBytes, stored.get(`/preview/${jobId}`).length);
  assert.equal(callback.payload.tagged, false);
});

test("audio MP3 de entrada: también genera preview y picos", async () => {
  const { callback } = await transcodeAudio("mp3");
  assert.equal(callback.payload.ok, true, callback.payload.error);
  assert.equal(callback.payload.peaks.length, 800);
  assert.equal(callback.payload.meta.codec, "mp3");
});

test("tag de voz: se mezcla cada N segundos sin cambiar la duración y el preview sin tag queda limpio", async () => {
  const plain = await transcodeAudio("silent");
  const tagged = await transcodeAudio("silent", { voiceTagUrl: `http://127.0.0.1:${fakePort}/orig/tag`, voiceTagIntervalS: 5 });
  assert.equal(tagged.callback.payload.ok, true, tagged.callback.payload.error);
  assert.equal(tagged.callback.payload.tagged, true);
  const dur = (f) => Number(probe(f).format.duration);
  const fPlain = previewFile(plain.jobId);
  const fTag = previewFile(tagged.jobId);
  assert.ok(Math.abs(dur(fTag) - dur(fPlain)) < 0.3, "misma duración");
  // la canción es silencio: donde entra el tag (a los 5 s) hay señal y en el resto no
  fs.copyFileSync(fTag, path.join(os.tmpdir(), "dbg-tagged.mp3"));
  const atTag = maxVolume(fTag, 5.0);
  const away = maxVolume(fTag, 1.0);
  const plainAtTag = maxVolume(fPlain, 5.0);
  assert.ok(atTag > -30, `el tag suena a los 5 s (${atTag} dB)`);
  assert.ok(away < -60, `sin tag fuera de su instante (${away} dB)`);
  assert.ok(plainAtTag < -60, `el preview sin tag no lo lleva (${plainAtTag} dB)`);
});

test("audio de 10 minutos: se procesa en streaming (memoria acotada) y se calculan los picos", async () => {
  const t0 = Date.now();
  const { callback } = await transcodeAudio("long");
  assert.equal(callback.payload.ok, true, callback.payload.error);
  assert.ok(Math.abs(callback.payload.meta.duration - 600) < 1);
  assert.equal(callback.payload.peaks.length, 800);
  console.log(`   (10 min de audio procesados en ${Math.round((Date.now() - t0) / 100) / 10} s)`);
});

test("audio: duración máxima, y rechazo de URLs de tag fuera de la lista", async () => {
  const { callback } = await transcodeAudio("wav", { limits: { maxDurationSec: 1, maxBytes: 2_000_000_000 } });
  assert.equal(callback.payload.ok, false);
  assert.match(callback.payload.error, /duración máxima/);
  const body = audioBody(crypto.randomUUID(), "wav", { voiceTagUrl: "http://169.254.169.254/tag" });
  assert.equal((await post(body, signedHeaders(SECRET, body))).status, 400);
  const bad = JSON.stringify({ ...JSON.parse(audioBody(crypto.randomUUID(), "wav")), type: "pdf" });
  assert.equal((await post(bad, signedHeaders(SECRET, bad))).status, 400);
});

test("audio: acumulador de picos (streaming, trozos partidos en bytes impares) y filtro del tag", () => {
  const samples = new Int16Array(8000).map((_, i) => (i < 4000 ? 1000 : 16000));
  const buf = Buffer.from(samples.buffer);
  const acc = new PeakAccumulator(8000, 8);
  for (let i = 0; i < buf.length; i += 7) acc.push(buf.subarray(i, i + 7)); // trozos de 7 bytes (impares)
  const out = acc.result();
  assert.equal(out.length, 8);
  assert.equal(Math.max(...out), 255);
  assert.ok(out[0] < 80 && out[7] === 255);
  assert.deepEqual(new PeakAccumulator(100, 4).result(), [0, 0, 0, 0]);
  const f = buildTagFilter(600, 25);
  assert.equal(f.copies, 23);
  assert.match(f.filter, /loudnorm/);
  assert.match(f.filter, /amix=inputs=24:normalize=0/);
  assert.equal(buildTagFilter(10_000, 25).copies <= 120, true, "tope de copias");
  assert.equal(buildTagFilter(3, 25), null);
  const args = buildAudioArgs("in", "tag", "out.mp3", 100, 25);
  assert.ok(args.includes("-filter_complex") && args.includes("160k") && args.includes("-id3v2_version"));
  assert.equal(readAudioProbe({ format: { duration: "5" }, streams: [{ codec_type: "audio", sample_rate: "44100", channels: 2, codec_name: "mp3" }] }).sampleRate, 44100);
});
