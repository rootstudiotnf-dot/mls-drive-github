# Servicio de procesado de vídeo: Node (solo librería estándar) + ffmpeg de Debian.
# El ffmpeg de Debian se compila con libzimg, así que dispone del filtro `zscale` para la conversión HDR → SDR.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -hide_banner -filters 2>/dev/null | grep -q zscale

WORKDIR /app
COPY package.json server.mjs signing.mjs ./

# Sin credenciales de almacenamiento en la imagen ni en el entorno: el servicio se niega a arrancar si las ve.
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
