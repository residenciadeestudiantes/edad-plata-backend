# Despliegue a producción

Notas para pasar el backend de SQLite local a un entorno de producción
real (servidor HTTPS). El análisis filológico/estadístico (Node, en
memoria) **no** necesita cambios para este volumen de corpus — ver la
justificación en la conversación que dio lugar a este documento; aquí solo
se cubre lo que sí hay que cambiar: base de datos, almacenamiento de
ficheros, variables de entorno y TLS.

> 🐳 **¿Vas a desplegar con Docker en un servidor on-prem?** Hay una guía
> paso a paso ya lista, con `docker-compose` (Postgres + backend + frontend
> + Caddy con HTTPS automático vía Let's Encrypt): ver
> [`deploy/README.md`](../deploy/README.md). Este documento explica el
> *por qué* de cada pieza; ese otro es el *cómo* concreto para ese caso.

## 1. Base de datos: SQLite → PostgreSQL

SQLite (el valor por defecto en desarrollo) no es apto para tráfico web
concurrente en producción (bloqueo de escritor único, sin historia de
backup/réplica). `config/database.ts` ya soporta PostgreSQL de forma
nativa (es la configuración estándar de Strapi); el driver `pg` ya está
en `package.json`.

### 1.1. Crear la base de datos

```sql
CREATE DATABASE strapi;
CREATE USER strapi WITH ENCRYPTED PASSWORD 'elige-una-contraseña';
GRANT ALL PRIVILEGES ON DATABASE strapi TO strapi;
```

### 1.2. Configurar las variables de entorno

En el `.env` del servidor de producción (ver plantilla en `.env.example`):

```
DATABASE_CLIENT=postgres
DATABASE_HOST=<host>
DATABASE_PORT=5432
DATABASE_NAME=strapi
DATABASE_USERNAME=strapi
DATABASE_PASSWORD=<contraseña>
DATABASE_SSL=true   # si el proveedor de Postgres lo exige (la mayoría en la nube)
```

`APP_KEYS`, `*_SECRET`, `*_SALT` y `ENCRYPTION_KEY` deben ser **nuevos y
distintos** a los de desarrollo (genera valores aleatorios, no reutilices
los locales).

### 1.3. Migrar los datos ya existentes en SQLite

Strapi tiene herramientas de exportación/importación integradas que mueven
todo el contenido (incluidas relaciones y ficheros subidos) sin tocar
ninguna tabla a mano:

```bash
# 1. Con el backend actual (SQLite) parado o en local, exporta todo:
npm run strapi -- export --no-encrypt -f backup-produccion

# Esto genera backup-produccion.tar.gz en la raíz del proyecto.

# 2. Copia ese archivo al servidor de producción (o a donde vayas a
#    ejecutar la importación) y, con el backend ya apuntando a la
#    PostgreSQL VACÍA recién creada (DATABASE_CLIENT=postgres en su .env),
#    ejecuta:
npm run strapi -- import -f backup-produccion.tar.gz
```

`strapi import` necesita arrancar Strapi internamente para escribir en la
base de datos configurada, así que asegúrate de que el `.env` con el que
se ejecuta ya apunta a PostgreSQL antes de importar. No hace falta tocar
el esquema a mano: Strapi lo recrea a partir de los content-types del
propio código (igual que hace en cada arranque).

## 2. Almacenamiento de ficheros subidos

Por defecto, Strapi guarda los ficheros subidos (imágenes de portada,
fotos de autor...) en el disco local (`public/uploads/`, ~140 MB
actualmente). **Si el servidor de producción usa un disco efímero**
(contenedores que se recrean en cada despliegue, la mayoría de PaaS sin
volumen persistente configurado), esos ficheros se perderían en el
siguiente despliegue.

Dos opciones, según dónde despliegues:

- **Disco persistente** (VPS, o PaaS con volumen montado en
  `public/uploads`): no requiere ningún cambio de código, solo asegurarte
  de que ese volumen sobrevive a los redespliegues y entra en tu copia de
  seguridad.
- **Almacenamiento de objetos (S3 o compatible)**: instalar
  `@strapi/provider-upload-aws-s3` (o el provider del proveedor que uses)
  y configurarlo en `config/plugins.ts`. Requiere credenciales del bucket
  como variables de entorno nuevas.

**Decisión para el despliegue Docker on-prem** (`deploy/`): disco
persistente, vía un volumen Docker con nombre
(`backend_uploads:/app/public/uploads` en `deploy/docker-compose.yml`).
Sobrevive a `docker compose up --build` y a reinicios del servidor; solo se
pierde si se borra explícitamente el volumen (`docker compose down -v`).

## 3. HTTPS

Strapi no termina TLS por sí mismo: `config/server.ts` escucha en HTTP
plano sobre `HOST`/`PORT`. El HTTPS lo aporta la capa delante:

- Un **proxy inverso** (nginx, Caddy) en el mismo servidor, con su
  certificado (p. ej. Let's Encrypt) y que reenvíe a `http://localhost:1337`.
- O la **terminación TLS del propio proveedor** (la mayoría de PaaS la dan
  gratis y automática delante de la app).

**Decisión para el despliegue Docker on-prem:** Caddy, en su propio
contenedor (`deploy/docker-compose.yml` + `deploy/Caddyfile`). Caddy
obtiene y renueva los certificados de Let's Encrypt automáticamente para
los dominios configurados, sin pasos manuales de certbot.

Sea cual sea, hay que indicarle a Strapi su URL pública real (para que
genere bien las URLs de los ficheros subidos y el panel de admin):

```
URL=https://api.tu-dominio.com
```

## 4. CORS y el frontend

El frontend (`edad-plata-frontend`) necesita:

```
NEXT_PUBLIC_STRAPI_URL=https://api.tu-dominio.com
```

Y Strapi necesita permitir ese origen en su configuración de seguridad
(`config/middlewares.ts`, middleware `strapi::cors`) — por defecto en
desarrollo es permisivo; en producción hay que restringirlo al dominio
real del frontend.

## 5. Checklist resumen

- [ ] PostgreSQL creado, accesible desde el servidor de producción.
- [ ] `.env` de producción con `DATABASE_CLIENT=postgres` y credenciales
      nuevas (no las de desarrollo).
- [ ] Datos migrados con `strapi export` / `strapi import`.
- [ ] Estrategia de almacenamiento de ficheros decidida (disco persistente
      o S3) y configurada.
- [ ] HTTPS terminado por proxy/proveedor, `URL` configurada.
- [ ] CORS de Strapi restringido al dominio real del frontend.
- [ ] `NEXT_PUBLIC_STRAPI_URL` del frontend actualizado a la URL de producción.
