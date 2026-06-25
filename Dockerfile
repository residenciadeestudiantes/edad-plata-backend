# Build multi-etapa. `sharp` (procesado de imágenes del plugin de subida)
# y `better-sqlite3` (dependencia directa, aunque en producción se use
# Postgres) necesitan compilar binarios nativos, de ahí las herramientas
# de compilación en la etapa de build; en la imagen final solo queda la
# librería de runtime que sharp necesita (vips), no las cabeceras de build.

FROM node:22-alpine AS build
WORKDIR /app

RUN apk add --no-cache build-base gcc autoconf automake zlib-dev libpng-dev nasm bash vips-dev python3 git

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV NODE_ENV=production
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache vips

ENV NODE_ENV=production
COPY --from=build /app ./
# public/uploads está en .dockerignore (no versionar datos en la imagen),
# así que hay que crearlo explícitamente: Strapi falla al arrancar si no
# existe, y si el volumen de producción se monta en /app/public entero,
# Docker solo inicializa el volumen con lo que ya exista aquí.
RUN mkdir -p public/uploads

EXPOSE 1337
CMD ["npm", "run", "start"]
