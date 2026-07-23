# Deploying web-namp on Synology (Container Manager / Podman / Docker)

web-namp ships as a small container image. The runtime is just `node:22-alpine`
plus one bundled server file (`server/dist/index.mjs`, express baked in) and the
built SPA (`client/dist/`) — **no `node_modules`**. It listens on **port 8058**
and runs fine as **root** (`0:0`), which is how Synology DSM starts containers.

Out of the box it runs in **demo mode** (procedural audio, no credentials). Add a
Yandex OAuth token to stream your real account.

> In this repo `docker` is aliased to `podman`. Every command below works with
> either — swap `podman` ↔ `docker` freely. Images/tars are tagged
> **`web-namp:latest`** (no `localhost/` prefix — see the note at the bottom).

---

## 1. Build the image (+ a Synology-importable tar)

From a machine with podman/docker and this repo checked out:

```bash
npm run image:build
```

This runs [`scripts/build-image.sh`](../scripts/build-image.sh), which:

1. `podman build -t web-namp:latest -f Dockerfile .`
2. `podman save`s a `docker-archive` and **strips podman's `localhost/` prefix**
   so the archive's `RepoTags` is exactly `["web-namp:latest"]`.
3. Writes **`dist/web-namp.tar`** (~157 MB) ready to import on the NAS.

Overrides via env vars:

```bash
SAVE=0 npm run image:build                                   # build only, no tar
IMAGE=web-namp:1.0 OUTPUT=dist/web-namp-1.0.tar npm run image:build
ENGINE=docker npm run image:build                            # force docker
```

(You can also build by hand: `podman build -t web-namp:latest -f Dockerfile .`)

---

## 2a. Deploy via the DSM GUI (Container Manager)

1. Copy the tar to the NAS, e.g.
   `scp dist/web-namp.tar admin@synology:/volume1/docker/`
2. **Container Manager → Image → Add → Add From File** → pick `web-namp.tar`.
   It imports as **`web-namp:latest`**.
3. **Image → select web-namp → Run**:
   - **Port settings:** Local port **8058** → Container port **8058** (TCP).
   - **Environment** (optional real account): add `YANDEX_TOKEN` = your token.
     (`NODE_ENV=production` and `PORT=8058` are already baked into the image.)
   - **Volume** (optional alternative to the env var): mount a file to
     `/app/.env` containing `YANDEX_TOKEN=...`.
   - Enable **auto-restart**.
4. Open `http://<nas-ip>:8058`.

## 2b. Deploy via CLI (podman/docker on the NAS)

```bash
docker load -i /volume1/docker/web-namp.tar        # imports web-namp:latest

# demo mode
docker run -d --name web-namp \
  -p 8058:8058 \
  --restart unless-stopped \
  web-namp:latest

# real account — either pass the token…
docker run -d --name web-namp \
  -p 8058:8058 \
  -e YANDEX_TOKEN=YOUR_TOKEN_HERE \
  --restart unless-stopped \
  web-namp:latest

# …or mount a .env file
docker run -d --name web-namp \
  -p 8058:8058 \
  -v /volume1/docker/web-namp/.env:/app/.env:ro \
  --restart unless-stopped \
  web-namp:latest
```

## 2c. Deploy as a Container Manager "Project" (compose)

DSM's Container Manager can import a `docker-compose.yml` as a **Project**. Use
the [`docker-compose.yml`](../docker-compose.yml) at the repo root (it builds
from source; for a NAS you'll usually point `image:` at the imported tag and drop
the `build:` block):

```yaml
services:
  web-namp:
    image: web-namp:latest
    container_name: web-namp
    user: "0:0"
    ports:
      - "8058:8058"
    environment:
      NODE_ENV: production
      PORT: "8058"
      # YANDEX_TOKEN: "paste-your-token-here"   # optional
    # env_file:
    #   - .env                                  # optional: YANDEX_TOKEN=...
    restart: unless-stopped
```

```bash
docker compose up -d          # or: podman-compose up -d
```

---

## 3. Getting a Yandex OAuth token

The token lets the server proxy your real Yandex Music account. It's short-lived
— refresh it when streaming starts failing.

Easiest, on your dev machine (validates + writes `.env` for you):

```bash
npm run set-token             # paste the token when prompted
```

Then either copy that `.env` to the NAS and mount it at `/app/.env`, or copy just
the `YANDEX_TOKEN=` value into the container's environment.

To get the raw token manually (this is what `set-token` automates — see
[`scripts/set-token.mjs`](../scripts/set-token.mjs) and the
[README](../README.md#connect-your-real-yandex-account-optional)):

1. Open, logged in to Yandex:
   `https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d`
2. Approve — you land on a URL containing `#access_token=…`.
3. Copy that `access_token` value → that's your `YANDEX_TOKEN`.

The token is held **in memory only** and forwarded as `Authorization: OAuth …`;
it is never logged. An invalid/expired token just falls back to demo mode.

---

## Notes

- **Port** is `8058` everywhere. Change the host side of the mapping to relocate
  it (`-p 9000:8058`); to change the in-container port pass `-e PORT=…` and map
  to it.
- **Health check:** `curl http://<nas-ip>:8058/api/status` →
  `{"mode":"demo",…}` or `{"mode":"yandex",…}`.
- **The `localhost/` prefix.** Podman stores unqualified images as
  `localhost/web-namp:latest`; the build script already strips that from the
  **tar**, and Docker/DSM import it cleanly as `web-namp:latest`. If a tool ever
  still shows `localhost/web-namp:latest` after import, retag it:

  ```bash
  docker tag localhost/web-namp:latest web-namp:latest
  docker rmi localhost/web-namp:latest
  ```

- **No Node install needed on the NAS beyond the container.** If you'd rather not
  run a container at all, see [single-binary.md](./single-binary.md) for a
  self-contained executable.
