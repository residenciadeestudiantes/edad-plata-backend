# Despliegue con Docker (on-prem, Let's Encrypt)

Levanta los 4 contenedores (PostgreSQL, backend Strapi, frontend Next.js y
Caddy como proxy con HTTPS automático) en el mismo servidor. Ver también
[`../docs/despliegue-produccion.md`](../docs/despliegue-produccion.md) para
el contexto general (esto es la variante "todo en Docker" de esa guía).

## 0. Antes de empezar

- Apunta `DOMAIN_APP` y `DOMAIN_API` (registros DNS tipo A) a la IP pública
  de este servidor. Caddy no podrá emitir el certificado si el dominio no
  resuelve todavía.
- Abre los puertos **80 y 443** en el firewall del servidor hacia este
  servidor (Caddy los necesita para el reto HTTP-01 de Let's Encrypt y para
  servir HTTPS). El puerto de Postgres (5432) no se expone al host —
  `docker-compose.yml` no lo publica, solo es accesible entre contenedores.
- Docker Engine + el plugin Compose instalados en el servidor (`docker compose version`).

## 1. Clonar ambos repos como carpetas hermanas

`docker-compose.yml` espera esta estructura (el frontend se referencia con
una ruta relativa `../../frontend` desde `backend/deploy/`):

```bash
mkdir -p /opt/edad-plata && cd /opt/edad-plata
git clone https://github.com/residenciadeestudiantes/edad-plata-backend.git backend
git clone https://github.com/residenciadeestudiantes/edad-plata-frontend.git frontend
cd backend
```

(Usa las ramas/tags que quieras desplegar; por defecto, el clon trae `main`.)

## 2. Configurar variables de entorno

Dos archivos `.env` distintos:

```bash
# Secretos de Strapi (APP_KEYS, *_SECRET, *_SALT, ENCRYPTION_KEY)
cp .env.example .env
# Genera valores nuevos para cada uno, no reutilices los de desarrollo.
# DATABASE_* en este archivo se ignoran: docker-compose.yml los sobreescribe
# para apuntar al contenedor postgres.

# Dominios, email de Let's Encrypt y credenciales de Postgres
cd deploy
cp .env.example .env
# Rellena DOMAIN_APP, DOMAIN_API, LETSENCRYPT_EMAIL, DATABASE_PASSWORD.
```

## 3. Levantar todo

```bash
cd /opt/edad-plata/backend/deploy
docker compose up -d --build
```

La primera vez tarda varios minutos (build de las dos imágenes + arranque
de Postgres). Sigue los logs con:

```bash
docker compose logs -f
```

Caddy obtiene el certificado de Let's Encrypt automáticamente en cuanto
`DOMAIN_APP`/`DOMAIN_API` resuelven hacia este servidor; no hace falta
ningún paso manual de certbot.

## 4. Migrar los datos que ya existen en SQLite (si vienes de desarrollo local)

Con el backend en Docker ya arrancado (con su Postgres vacío). Hazlo antes
de dar el dominio por "en producción de verdad" / de que reciba tráfico
real: `strapi import` escribe directamente en la base de datos configurada
y conviene no mezclarlo con escrituras concurrentes de usuarios.

```bash
# En tu máquina de desarrollo (donde está el .tmp/data.db con los datos):
cd edad-plata/backend
npm run strapi -- export --no-encrypt -f backup-produccion
# Copia backup-produccion.tar.gz al servidor, por ejemplo:
scp backup-produccion.tar.gz usuario@servidor:/opt/edad-plata/backend/

# En el servidor, importa dentro del contenedor backend ya en marcha:
cd /opt/edad-plata/backend/deploy
docker compose cp ../../backup-produccion.tar.gz backend:/app/backup-produccion.tar.gz
docker compose exec backend npm run strapi -- import -f /app/backup-produccion.tar.gz --force
```

## 5. Comprobaciones

```bash
curl -I https://<DOMAIN_API>/admin
curl -I https://<DOMAIN_APP>/
```

Ambas deberían responder `200`/`30x` con certificado válido.

## Operaciones habituales

- **Actualizar tras un nuevo commit en `main`:**
  ```bash
  cd /opt/edad-plata/backend && git pull
  cd ../frontend && git pull
  cd ../backend/deploy && docker compose up -d --build
  ```
- **Cambiar el dominio del backend:** hay que reconstruir también la
  imagen del frontend (`NEXT_PUBLIC_STRAPI_URL` se incrusta al compilar),
  no solo cambiar `.env` y reiniciar.
- **Copia de seguridad periódica:** `docker compose exec backend npm run strapi -- export --no-encrypt -f /app/backup-$(date +%F)` (y copiar el resultado fuera del servidor), además de un `pg_dump` del volumen `postgres_data` si quieres redundancia a nivel de base de datos.
