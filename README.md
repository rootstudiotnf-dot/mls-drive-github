# MLS Drive

Plataforma web privada para gestionar sesiones de fotos, vídeos, beats y archivos por artista. **Fase 0:** base del proyecto, sistema de diseño y estructura de pantallas (sin backend ni datos reales).

**Fase 3:** subida de archivos a Cloudflare R2: guía en [`docs/SETUP-R2.md`](docs/SETUP-R2.md).

**Fase 1:** acceso con cuenta, usuarios e invitaciones (Supabase). Antes de arrancar hay que configurar Supabase: sigue [`docs/SETUP-SUPABASE.md`](docs/SETUP-SUPABASE.md).

**Fase 10 (cierre):** seguridad, rendimiento, copias, despliegue y lanzamiento: [`docs/AUDITORIA-SEGURIDAD.md`](docs/AUDITORIA-SEGURIDAD.md) · [`docs/BACKUPS.md`](docs/BACKUPS.md) · [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md) · [`docs/LANZAMIENTO.md`](docs/LANZAMIENTO.md) · [`docs/GUIA-OWNER.md`](docs/GUIA-OWNER.md).

Más contexto: [`docs/PRODUCT.md`](docs/PRODUCT.md) · Reglas de trabajo: [`CLAUDE.md`](CLAUDE.md).

## Requisitos

- Node.js 22.18 o superior (probado con 24; el script `create-owner` ejecuta TypeScript directamente)
- npm
- Un proyecto de Supabase configurado ([guía](docs/SETUP-SUPABASE.md))

## Arranque

```bash
npm install
cp .env.example .env.local   # rellénalo (ver la guía)
npm run create-owner         # una sola vez: crea la invitación del primer owner
npm run dev
```

Abre <http://localhost:3000>. Sin sesión te lleva a `/login`.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Compilación de producción |
| `npm run start` | Sirve la compilación de producción |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run create-owner` | Crea la invitación del primer owner (una vez) |
| `npm test` | Pruebas unitarias (claves y validación de archivos) |
| `npm run purge-trash -- --dry-run` | Muestra qué borraría la limpieza de papelera y subidas abandonadas |
| `npm run seed-demo -- --yes` | Datos de ejemplo (3 artistas, sesiones, assets y 2 beats; solo metadatos; `--big[=N]` añade N assets por artista). Solo desarrollo |

## Rutas

Públicas: `/login` · `/invitacion` · `/auth/callback`.
Con sesión: `/` · `/artistas` · `/sesiones` · `/beats` · `/vault`.
Según permisos del rol: `/subir` (subir archivos) · `/archivo/[id]` (ficha) · `/usuarios` (`users.manage`/`users.invite`) · `/usuarios/roles` (`roles.manage`) · `/accesos` (`access.manage`) · `/almacenamiento` (administración).

## Variables de entorno

Ver `.env.example`. La `SUPABASE_SERVICE_ROLE_KEY` es secreta y solo de servidor.
