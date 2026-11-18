# Checklist de lanzamiento

Hazlo **en el entorno de pruebas primero** y luego en producción. Marca cada paso y anota fecha y resultado. Si un paso falla, no sigas:
corrige y repite. Tiempo estimado: una tarde (sin contar la propagación del DNS y la verificación del dominio de correo).

## A. Antes de abrir la puerta

- [ ] `docs/DESPLIEGUE.md` §9 completo (Supabase, R2, Vercel, DNS, correo, CI, protección de `main`).
- [ ] CI en verde sobre `main` y el despliegue de producción con el commit correcto.
- [ ] `npm run seed-prod -- --check` sin ✗ (roles, permisos, carpetas del Vault y ajustes presentes).
- [ ] `/admin/estado` con todo en «Correcto» (el transcodificador y la cuota pueden aparecer «No configurado» hasta que los pongas).
- [ ] **Primera copia hecha y restaurada en pruebas** (`docs/BACKUPS.md` §3) y anotado el tiempo real.
- [ ] Notas de securityheaders.com y SSL Labs anotadas. Lighthouse de las pantallas clave hecho (`docs/RENDIMIENTO.md`).
- [ ] Pasada la **auditoría de seguridad** (`docs/AUDITORIA-SEGURIDAD.md`) sin hallazgos altos abiertos y `gitleaks` sobre el repositorio.

## B. Primer arranque (pasos del owner)

1. [ ] **Primer owner**: `npm run create-owner` con tu correo → abre el enlace del correo → crea tu contraseña en `/invitacion`.
2. [ ] **Verificación en dos pasos** de tu cuenta: `/cuenta/seguridad` → guarda los **códigos de recuperación** (se muestran una vez) en
       tu gestor de contraseñas. Sin esto no podrás abrir el Vault.
3. [ ] **Roles**: revisa `/usuarios/roles` (Owner, Admin, Artist, Photographer, Collaborator) y ajusta solo lo que necesites.
       Crea un rol propio si lo necesitas (p. ej. «Filmmaker»): nadie puede tener más poder que tú ni que quien lo crea.
4. [ ] **Carpetas base**: al crear un artista se generan solas «Fotos», «Vídeos» y «Archivos»; el Vault ya trae sus 6 carpetas base.
5. [ ] **Invita a un colaborador** (`/usuarios` → Invitar → rol *Collaborator* o *Photographer*): recibe el correo, crea su contraseña y entra.
       Comprueba que el correo **no cae en spam** (`docs/DESPLIEGUE.md` §5).
6. [ ] **Crea un artista de prueba** (`/artistas` → Nuevo) e **invítalo** desde su ficha → pestaña *Accesos*; entra con su cuenta en
       otra ventana privada y comprueba que **solo ve lo suyo** (portal `/espacio`).
7. [ ] **Sube una sesión real**: `/subir` → fotos (clasifica el artista y la sesión) → espera a las miniaturas → **publícala**. El
       artista de prueba la ve; el colaborador sin acceso, no.
8. [ ] **Sube un vídeo real**: se procesa (proxy 1080p y póster; puede tardar) → publícalo → el artista lo reproduce y comenta con marca de tiempo.
9. [ ] **Comparte un enlace**: *Compartir* en la sesión (caducidad 7 días, con contraseña) → ábrelo en una ventana privada → comprueba
       la contraseña, las fotos y la descarga → **revócalo** en *Accesos → Enlaces* y confirma que da «no disponible».
10. [ ] **Vault**: concede acceso a la carpeta *Documentos* a una persona de confianza (30 días), comprueba que ve **solo** esa carpeta,
        y revócalo. Mira `/vault/registro`.
11. [ ] **Avisos**: publica fotos y comprueba que llega **un** aviso agrupado y el resumen del día; prueba la baja desde el pie del correo.
12. [ ] **Revisión final de permisos**: con el artista de prueba y con el colaborador, intenta abrir por la URL cosas que no son
        suyas (una sesión de otro artista, `/accesos`, `/vault`, `/admin/estado`): **todo debe dar «No encontrado»**.
13. [ ] **Borra los datos de prueba** (artista y archivos de prueba: papelera → eliminar definitivamente) y **desactiva la cuenta de
        prueba**. Anota la fecha de salida.

## C. Después del lanzamiento

- [ ] Primera semana: mira `/admin/estado` cada día y `/actividad` cada pocos días.
- [ ] Primer mes: sube DMARC de `p=none` a `p=quarantine` si los informes están limpios.
- [ ] Cada trimestre: restaura una copia en pruebas y apunta el tiempo. Cada año: rota las claves (`docs/BACKUPS.md` §5).
- [ ] Qué hacer si algo falla: `docs/BACKUPS.md` §4 y `docs/GUIA-OWNER.md` §«Acceso sospechoso».
