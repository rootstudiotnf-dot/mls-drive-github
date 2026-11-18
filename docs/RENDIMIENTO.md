# Rendimiento (Fase 10)

Medido el 18 nov 2026 sobre la **build de producción** (`next start`) en un portátil (Windows 11), con Supabase y almacenamiento
**simulados en la misma máquina**. Datos de volumen: 500 assets para un artista, una sesión de 500 fotos (rejilla justificada),
100 beats publicados, 20 vídeos listos. Principio: primero se mide, luego se corrige; no se tocó nada que no hubiera medido.

> **Aviso sobre las cifras.** Con base de datos y R2 en local no hay latencia de red, y el simulado de Supabase compite por la
> misma CPU. Sirven para detectar trabajo de más en la aplicación y comparar versiones, **no** como promesa de tiempos en
> producción. LCP y CLS reales requieren **Lighthouse sobre el dominio desplegado** (pendiente, ver abajo).

## Resultados

### Carga de las pantallas clave (navegador, caché fría)

| Pantalla | TTFB | Carga (`load`) | Nodos DOM | Peticiones | HTML | CLS |
| --- | --- | --- | --- | --- | --- | --- |
| Inicio | 40 ms | 111 ms | 269 | 36 | 48 KB | 0 |
| Espacio de artista (500 assets, 48 por página) | 82 ms | 150 ms | 1 158 | 66 | 176 KB | 0 |
| Galería de sesión (500 fotos) | 131 ms | 175 ms | 724 | 74 (26 miniaturas) | 187 KB | 0,003 |

- **Solo se pidieron las 26 miniaturas visibles** de las 500 fotos (IntersectionObserver por lotes de 50) y el DOM se queda en
  724 nodos: la virtualización y la carga diferida funcionan. Con las miniaturas rotas el cliente reintentaba de forma acotada.
- **LCP: no medido de forma fiable.** La ventana de pruebas estaba en segundo plano (`document.visibilityState = "hidden"`) y
  el primer pintado salía retrasado (1,8–3 s) por eso, no por la aplicación. **Pendiente**: Lighthouse sobre el despliegue.
- CLS 0,003: las fotos reservan su sitio (anchura/altura y color medio como marcador).

### Prueba de carga ligera (50 usuarios simultáneos)

50 usuarios × 3 vueltas × 9 rutas = **1 350 peticiones en 16 s (85 por segundo), 0 errores** (HTML completo, con sesión):

| Ruta | n | p50 | p95 | máx | HTML |
| --- | --- | --- | --- | --- | --- |
| Inicio | 150 | 406 ms | 550 ms | 594 ms | 48 KB |
| Espacio de artista (500 assets) | 150 | 651 ms | 821 ms | 1 004 ms | 176 KB |
| Sesión de 500 fotos | 150 | 724 ms | 896 ms | 1 097 ms | 187 KB |
| Vídeo | 150 | 616 ms | 822 ms | 1 049 ms | 39 KB |
| Biblioteca de beats (100) | 150 | 579 ms | 780 ms | 935 ms | 143 KB |
| Ficha de beat | 150 | 697 ms | 934 ms | 1 117 ms | 40 KB |
| Comentarios | 150 | 448 ms | 607 ms | 678 ms | 31 KB |
| Portal del artista | 150 | 664 ms | 844 ms | 1 051 ms | 48 KB |
| Portal · beats | 150 | 440 ms | 724 ms | 908 ms | 123 KB |

Con 50 personas a la vez ninguna ruta pasa de 1,2 s en el peor caso. La plataforma es de un solo propietario y su equipo:
50 simultáneas es un orden de magnitud por encima del uso esperado.

### JavaScript por ruta (gzip, lo que baja el navegador)

Rango **16–55 KB** por ruta: login 22 KB, inicio 28 KB, espacio de artista 45 KB, galería de sesión **55 KB** (la mayor, con el
visor y la rejilla), ficha de beat 46 KB, reproductor de vídeo 42 KB, enlace público 25 KB. Total de la aplicación: 49 *chunks*,
422 KB gzip, **compartidos entre rutas**. El visor, el reproductor y los *workers* de imagen ya se cargan solo donde se usan.
No hay nada que recortar con criterio; no se hizo ningún cambio.

### Base de datos

- `supabase/tests/explain.sql` falla si una consulta principal recorre la tabla entera. Cubre: assets por artista+tipo, por
  sesión, por carpeta y por cursor `(created_at, id)`, sesiones por artista, actividad por recurso, *grants* por usuario y
  recurso, y —**nuevo en la Fase 10**— comentarios de un archivo, bandeja de avisos, enlace por hash, historial de enlace, cola
  de correo, última copia y errores recientes. Todas usan índice. Los índices de `artist_id`, `session_id`, `folder_id`,
  `status`, `created_at` y las claves de `grants` ya existen (`create index` en 0002–0009).
- Escala (`beats-scale.sql`, 5 000 beats sintéticos): búsqueda de texto 154–167 ms, género+BPM 19 ms, cursor profundo 255 ms,
  recorrido completo exacto de los 5 000. Con RLS fila a fila (`can_access`) para un artista: primera página **1,1 s** (el caso
  más caro: es el precio de comprobar permisos por fila; aceptable a esta escala y con margen para una caché si creciera).
- Sin N+1: los listados piden las miniaturas en **una** llamada por página (`getThumbUrls`) y los permisos en la propia consulta.

### Caché

Nada privado usa caché compartida: las páginas son dinámicas (Next.js las sirve con `Cache-Control: private, no-cache, no-store`;
no se verificó cabecera a cabecera), `/c/*` y `/baja/*` van con `no-store`, y las URLs firmadas caducan en 5 min (ver), 2 min (descargar),
2 min/60 s (Vault) y 15 min (previews de beats). Las rutas estáticas son solo `robots.txt` e `icon.svg`.

### Subidas, descargas y animaciones

- Subidas reanudables y ZIP de sesiones grandes: se probaron en las Fases 3 y 5 (corte de red, reanudación, ZIP de 500 fotos byte
  a byte, partes de 3,5 GB con File System Access). **No se repitieron en la Fase 10**, salvo la subida del Vault (132 criterios,
  incluido multipart con 4 partes y reanudación) y la comprobación de firma, que no cambiaron los tiempos.
- Animaciones: solo `transform`, `opacity` y color en 150–200 ms, respetando `prefers-reduced-motion` (regla 6). Sin medir en
  móviles reales.

## Antes / después

| Medida | Antes (Fase 9) | Después (Fase 10) | Qué cambió |
| --- | --- | --- | --- |
| JS de la galería (gzip) | 55 KB | 55 KB | Nada: no había nada que optimizar |
| Rutas prerenderizadas | 3 (`/_not-found`, `/icon.svg`, `/robots.txt`) | 2 (`/icon.svg`, `/robots.txt`) | `/_not-found` pasa a renderizarse por petición: necesario para que lleve el nonce de la CSP; las demás páginas ya eran dinámicas por la sesión |
| Consultas con índice verificado | 7 | 14 | +7 casos de `EXPLAIN` |
| Cabeceras de seguridad | 5 | 10 | CSP, HSTS, COOP, CORP, `Permissions-Policy` ampliada |

No hubo regresión medible: la CSP y el límite de login añaden microsegundos (generar un nonce y una llamada `rate_hit` solo en
el login).

## Pendiente (no medido)

1. **Lighthouse (móvil y escritorio) sobre el dominio real**: LCP < 2,5 s y CLS < 0,1 con fotos de verdad en R2. Hacerlo con
   Chrome en primer plano: `npx lighthouse https://tu-dominio/… --view` tras iniciar sesión (o con la pestaña «Lighthouse» de Chrome).
2. Prueba de carga **contra el entorno de pruebas desplegado** (latencia real a Supabase y a R2).
3. Rendimiento en **móviles medios** reales (galería de 500 fotos y reproductor).
4. HTML de la galería y del espacio (≈180 KB): si en producción pesara, paginar los datos iniciales.
