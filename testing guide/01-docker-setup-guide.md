# Docker Setup for Roomies API Testing

You don't have Docker yet, so start here. This gives you a **disposable** Postgres (with PostGIS) + Redis pair that
spins up before the test run and tears down after — your real dev DB (`roomies_db` on 5432) is never touched.

## 1. Install Docker

**Windows:** Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). It requires WSL2 — the installer
will prompt you to enable it if it isn't already. Reboot after install, then open Docker Desktop once to let it finish
initializing.

**macOS:** Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Apple Silicon or Intel build
depending on your Mac).

**Linux:** Follow the [official Docker Engine install docs](https://docs.docker.com/engine/install/) for your distro,
then `sudo usermod -aG docker $USER` and log out/in so you don't need `sudo` for every command.

Verify it worked:

```bash
docker --version
docker compose version
```

## 2. `docker-compose.test.yml`

Place this at your project root (alongside `package.json`). Deliberately uses **different ports** (5433, 6380) than your
dev Postgres/Redis (5432, 6379) so both can run simultaneously without conflict.

```yaml
name: roomies-test

services:
    test-db:
        image: postgis/postgis:16-3.4-alpine
        environment:
            POSTGRES_USER: postgres
            POSTGRES_PASSWORD: postgres
            POSTGRES_DB: roomies_test
        ports:
            - "5433:5432"
        tmpfs:
            - /var/lib/postgresql/data # RAM-backed — fast, and wiped on container removal
        healthcheck:
            test: ["CMD-SHELL", "pg_isready -U postgres -d roomies_test"]
            interval: 2s
            timeout: 3s
            retries: 20

    test-redis:
        image: redis:7-alpine
        ports:
            - "6380:6379"
        command: ["redis-server", "--save", ""] # no persistence needed for test runs
        healthcheck:
            test: ["CMD", "redis-cli", "ping"]
            interval: 2s
            timeout: 3s
            retries: 20
```

Why `tmpfs` for Postgres: the whole point of a test DB is that it's rebuilt every run — RAM-backed storage means no
leftover volume to accidentally reuse, and it's noticeably faster for the migrate + truncate cycles a test suite does
constantly.

## 3. `.env.test`

Add this alongside your `.env.local` / `.env.azure` (also add it to `.gitignore` — same as `.env.local`).

```
NODE_ENV=test
PORT=3001

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/roomies_test
REDIS_URL=redis://127.0.0.1:6380

JWT_SECRET=test_only_jwt_secret_do_not_use_in_prod_00000000000000
JWT_REFRESH_SECRET=test_only_refresh_secret_do_not_use_in_prod_0000000
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

EMAIL_PROVIDER=ethereal
SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
SMTP_USER=test@ethereal.email
SMTP_PASS=testpass
SMTP_FROM=noreply@roomies.test

STORAGE_ADAPTER=local
ALLOWED_ORIGINS=http://localhost:5173
TRUST_PROXY=false
DB_POOL_MAX=5
```

Note: `EMAIL_PROVIDER=ethereal` here is a placeholder to satisfy `envSchema` validation — no email tests actually send
anything real, since `enqueueEmail()` just pushes a BullMQ job and no email worker runs during `supertest` (see the
architecture doc — we never call `src/server.js`, only `src/app.js`).

## 4. Commands you'll run

```bash
# start the throwaway DB/Redis pair (waits until both pass healthcheck)
docker compose -f docker-compose.test.yml up -d --wait

# apply all migrations to the fresh test DB
ENV_FILE=.env.test node src/db/migrate.js

# run the suite (see package.json changes in the architecture doc)
npm run test

# tear everything down (also wipes the tmpfs data)
docker compose -f docker-compose.test.yml down -v
```

The `npm run test` script (defined in the architecture plan doc) wraps all of this into one command, so day-to-day
you'll just run `npm run test` and nothing else.

## 5. One thing to double check

`postgis/postgis:16-3.4-alpine` needs to match roughly the Postgres major version you're already running against Neon in
prod (Postgres 16 per your migration comments) — alpine image is small and starts fast, which matters since this
container is torn down and rebuilt on every test run.
