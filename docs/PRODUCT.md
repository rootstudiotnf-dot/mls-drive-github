# MLS Drive — Producto y decisiones

> Nombre provisional. Plataforma web **privada** para gestionar contenido audiovisual y musical: sesiones de fotos, vídeos, beats y archivos, organizados por artista, con usuarios y permisos.

## Alcance y contexto

- Producto privado para **un solo propietario** (no multi-tenant).
- Interfaz en **español**.
- El **artista** es el contenedor principal del contenido (sesiones, vídeos, archivos).
- Los **beats** son una biblioteca aparte, independiente de los artistas.
- Roles previstos: **Owner, Admin, Artist, Photographer, Collaborator**, más roles personalizados creados por el admin.

## Stack

- Next.js (App Router, última estable), TypeScript estricto, Tailwind CSS.
- Más adelante (NO instalado todavía): **Supabase** (auth y base de datos) y **Cloudflare R2** (archivos).

## Fases

| Fase | Contenido |
| --- | --- |
| 0 | Proyecto base, sistema de diseño, estructura de pantallas (sin backend, auth ni datos reales). |
| 1 | Autenticación (Supabase), usuarios e invitaciones. Cuentas solo por invitación; rutas protegidas en servidor; roles en tabla con 5 roles de sistema. Ver `docs/SETUP-SUPABASE.md`. |
| 2 | Modelo de datos completo y motor de permisos: roles editables, permisos por rol, accesos por recurso y auditoría. Ver «Permisos (Fase 2)». |
| 3 | Almacenamiento en Cloudflare R2: subidas directas (multipart, reanudables), URLs firmadas, clasificación y ficha de archivo. Ver `docs/SETUP-R2.md`. |
| 6 | Vídeo: procesado en un servicio aparte (proxy 1080p + póster), reproductor propio y comentarios con marca de tiempo. Ver `docs/SETUP-TRANSCODER.md`. |
| 9 | Colaboración: enlaces externos con caducidad, comentarios centralizados y menciones, avisos por correo y bandeja. Ver «Colaboración (Fase 9)» y `docs/SETUP-COLLAB.md`. |
| 10 | Cierre: auditoría de seguridad (CSP, límite de login, firma real de los archivos), rendimiento, copias y recuperación, estado y alertas, despliegue y lanzamiento. Ver «Cierre y lanzamiento (Fase 10)». |
| 4 | Espacios por artista: carpetas, publicación y acceso. Panel de administración (`/artistas`) y portal para artistas y colaboradores (`/espacio`). Ver «Espacios por artista (Fase 4)». |

### Acceso (Fase 1)

- Registro público desactivado: la cuenta nace al invitar (`/usuarios` → «Invitar usuario») y se activa cuando la persona crea su contraseña en `/invitacion`.
- Estados: Activo · Invitación enviada · Invitación caducada (7 días) · Desactivado.
- Owner: único, no se desactiva ni se degrada, y no se crea desde la interfaz (solo con `npm run create-owner`). Un admin solo gestiona roles que no sean owner ni admin.
- La puerta de acceso a los datos es `profiles.status = 'active'`, aplicada en RLS, en el proxy y en cada acción de servidor.

## Navegación

Barra lateral: Inicio, Proyectos (artistas), Sesiones, Beats, Vault. Sección "Administración": Usuarios, Accesos. Usuario abajo ("Isaac Saavedra · Owner").

| Ruta | Pantalla |
| --- | --- |
| `/` | Inicio: saludo con fecha, buscador, sesiones recientes (4/5), artistas |
| `/artistas` | Proyectos (artistas) |
| `/sesiones` | Sesiones |
| `/beats` | Beats |
| `/vault` | Vault |
| `/usuarios` | Usuarios |
| `/accesos` | Accesos |

Por debajo de 900 px la barra lateral pasa a menú desplegable superior.

## Permisos (Fase 2)

**Denegar por defecto.** La decisión vive en la base de datos (funciones `has_permission` y `can_access`, las mismas que usan las políticas RLS) y se invoca desde el servidor con `requirePermission(...)`. La interfaz solo refleja.

- **Catálogo (34 permisos):** `<área>.<acción>` con áreas photos, videos, files, beats, vault y acciones view, download, upload, edit, delete, publish; más `users.invite`, `users.manage`, `access.manage`, `roles.manage`.
- **Roles (tabla editable):** `scope` `all` (todos los artistas) o `assigned` (solo asignados) y `is_locked` (owner, inmutable). Por defecto: owner todo; admin todo salvo `vault.*` y `roles.manage`; artist ve y descarga fotos/vídeos/archivos y ve beats; photographer ve, sube y edita fotos; collaborator ve fotos, vídeos y archivos.
- **El rol es el techo.** Un *grant* (acceso por recurso: artista, sesión, carpeta, asset, beat o Vault) solo elige **dónde** se aplica; nunca amplía lo que el rol permite. Los grants se heredan hacia abajo (artista → sesión → carpeta(s) → asset), pueden caducar y revocarse. `delete` y `publish` los habilita el flag `can_edit`.
- **Regla `can_access` (todas deben cumplirse):** usuario activo y recurso no borrado · el rol tiene `<área>.<acción>` · alcance (rol `all`, o asignación a un artista, o grant vigente en el recurso o un ancestro) · visibilidad (sin `*.edit`/`*.publish` solo se ven assets publicados o propios) · Vault (exige además un grant `vault` explícito; el owner siempre pasa; no hereda de artistas ni sesiones) · descarga (exige `downloadable = true`).
- **Beats:** son una biblioteca aparte (sin artista). Un rol con alcance `assigned` solo los ve con un grant de tipo `beat`.
- **Anti-escalada** (roles): nadie concede permisos que no tiene, edita su propio rol, ni crea/edita/duplica un rol más poderoso que el suyo; los roles de sistema no se eliminan; el owner es inmutable (también por trigger); siempre queda al menos un usuario activo con `roles.manage`. En **usuarios**, solo se gestionan roles estrictamente menos poderosos (con los de serie: el admin gestiona por debajo del admin).
- **Auditoría:** `activity_log` es de solo inserción (un trigger impide modificarla o borrarla, también al service role).

Pantallas: `/usuarios/roles` (requiere `roles.manage`) y `/accesos` (requiere `access.manage`: asignaciones persona↔artista y grants).

## Sistema de diseño

Tema oscuro único. Referencias: Apple, Frame.io, apps nativas de macOS. Sobrio y premium; **las fotos son las protagonistas**.

- **Colores:** fondo `#0B0B0C`, superficie `#141416`, placeholders `#1A1A1D #1F1F22 #232326 #28282C #2B2B2F`. Texto `#F5F5F7`, secundario `#A1A1A6`, atenuado `#8E8E93` (contraste ≥ 4.5:1).
- **Líneas:** borde `rgba(255,255,255,0.08)`, hover `0.18`, activo `0.08`.
- **Tipografía:** `-apple-system, "SF Pro Display", Inter, system-ui` (Inter vía `next/font`). Títulos 32/600, tracking −0.02em; cuerpo 14; etiquetas 12–13.
- **Radios:** 8 controles, 10–12 tarjetas, 14–16 bloques grandes, 999 botones y chips.
- **Espaciado:** contenido con padding 32/48 px; secciones separadas 32–48 px.
- **Botones:** primario = pill `#F5F5F7` con texto `#0B0B0C`; secundario/fantasma = pill con borde.
- **Movimiento:** transiciones de 150–200 ms en hover y foco; `:focus-visible` claro; respeta `prefers-reduced-motion`.
- **Prohibido:** gradientes, cristal translúcido, colores saturados, sombras pesadas, aspecto de plantilla de dashboard SaaS.

## Espacios por artista (Fase 4)

**Dos layouts, elegidos por permisos (nunca por nombre de rol).** Quien tenga algún permiso de administración (`users.invite`, `users.manage`, `access.manage`, `roles.manage` o `artists.manage`) usa el **panel**: barra lateral y `/artistas`. Quien no tenga ninguno (artistas y colaboradores) usa el **portal**: barra superior, sin barra lateral y `/espacio`. Tras iniciar sesión, `/` redirige al portal a esa gente. Las pantallas de administración responden **404** a quien está en el portal.

**Panel (`/artistas/[slug]`).** Pestañas Todo · Fotos · Vídeos · Archivos · Beats · Accesos · Actividad · Papelera (cada una solo si el rol la permite). Carpetas (crear, renombrar, ordenar, borrar si están vacías), listados paginados de 48 con miniaturas, selección múltiple y acciones en lote: publicar, despublicar, mover (carpeta o artista) y papelera. Ajustes del artista (nombre, biografía, avatar, archivar) con `artists.manage`.

**Publicación.** Lo que sube alguien sin permiso de publicar queda **privado** («Pendiente de publicar»). Publicar exige `<área>.publish`, se registra en la actividad y es lo único que hace visible un archivo para el artista. Despublicar lo retira de inmediato. El artista ve solo lo publicado (más lo que subió él mismo) y de **su** espacio: otro artista, aunque conozca la URL, recibe **404** (nunca 403, para no revelar qué existe).

**Accesos del artista.** El equipo permanente son las asignaciones; los accesos concedidos llevan permisos (ver, descargar, subir) y caducidad. «Invitar a alguien» crea la invitación y su acceso en un paso. Revocar corta el acceso al instante (la base de datos lo evalúa en cada petición). Nadie concede más de lo que tiene.

**Archivos.** `storage_key` es opaca e inmutable: mover entre carpetas o artistas solo cambia filas, jamás renombra objetos en R2. Las miniaturas y descargas se sirven únicamente con URLs firmadas de corta vida. El avatar del artista es un asset propio y no aparece entre sus archivos.

**Fuera de esta fase:** galerías avanzadas, descarga en ZIP, visor, favoritos, comentarios en vídeo y el formulario de beats.

## Beat Library (Fase 7)

Catálogo `/beats` (búsqueda de texto, género, BPM, tonalidad, etiquetas, estado, artista con acceso; lista o portadas;
50 por página con scroll infinito), subida `/beats/nuevo`, ficha `/beats/[id]` (portada 1:1, forma de onda, datos,
compartir con artistas, comentarios con marca de tiempo y actividad), géneros `/beats/generos`, reproductor global
persistente y portal del artista `/espacio/[slug]/beats`. Solo se escucha el preview; descargar el original exige tres
capas (rol, beat descargable y permiso del artista). El owner puede añadir un tag de voz a los previews en `/ajustes/beats`.

## Private Vault (Fase 8)

Zona restringida para material original o sin publicar (vídeos originales, BTS, tomas descartadas, RAW, archivos de
proyecto, documentos). Bucket y token propios; acceso solo con rol, grant vigente (caduca siempre) y verificación en dos
pasos; desbloqueo con contraseña y cookie de 15 minutos; URLs de 2 min (ver) y 60 s (descargar); registro obligatorio de
cada acción (el owner lo ve y exporta en `/vault/registro`); mover al Vault y sacarlo desde el espacio del artista, las
sesiones y la ficha del archivo; papelera de 30 días. Guía: `docs/SETUP-VAULT.md`.

## Colaboración (Fase 9)

Enlaces externos para enseñar una sesión, una carpeta, una selección de fotos o de beats a quien no tiene cuenta: título,
mensaje, caducidad obligatoria (1, 7 o 30 días), contraseña opcional, descarga y comentarios opcionales y límite de
descargas. Se crean con «Compartir» y se gestionan en **Accesos → Enlaces** (estado, visitas, descargas, historial y
«Revocar ahora»). Comentarios centralizados en `/comentarios` (con @menciones, resueltos y comentarios de visitantes
externos), bandeja de avisos con campana, correos con Resend (inmediatos y resumen diario), preferencias en
`/cuenta/notificaciones` y línea de tiempo `/actividad` para quien gestiona accesos. El Vault queda fuera de todo.
Guía: `docs/SETUP-COLLAB.md`.

## Cierre y lanzamiento (Fase 10)

Sin funciones nuevas: auditoría de seguridad (`docs/AUDITORIA-SEGURIDAD.md`), medición de rendimiento (`docs/RENDIMIENTO.md`), copias y
recuperación (`docs/BACKUPS.md`), despliegue con dominio, correo autenticado y CI (`docs/DESPLIEGUE.md`), checklist de salida
(`docs/LANZAMIENTO.md`), guías (`docs/GUIA-OWNER.md`, `docs/GUIA-ARTISTAS.md`) y lo que queda por hacer (`docs/PENDIENTE.md`).
Añade el estado de los servicios (`/admin/estado`, solo owner) con alertas por correo, páginas 404/500/mantenimiento y el registro
de errores sin datos personales.

## Seguridad (Fase 0)

- Cabeceras: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restrictiva.
- `noindex, nofollow` (metadata y `X-Robots-Tag`) y `robots.txt` que bloquea todo.
- Sin analíticas ni scripts externos. Ningún secreto en el repositorio.
- Pendiente para fases con backend: CSP con nonce, autenticación, autorización en servidor/BD (RLS).

## Restricciones de la Fase 0

Sin autenticación, base de datos, subida de archivos ni datos reales (solo datos de ejemplo fijos). Sin librerías de UI ni de iconos. Solo dependencias: next, react, react-dom, tailwindcss, typescript y las de lint/tipos.
