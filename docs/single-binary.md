# Single-binary web-namp

Ship web-namp as **one self-contained executable** — the server plus the built
SPA — so it can be dropped onto a NAS or host with **no Node install and no
`node_modules`**. Two viable runtimes are covered:

- **Node 22 SEA** — implemented and verified in this repo (`npm run build:binary`).
- **Bun `--compile`** — smaller and cross-compiles; needs one small server change
  to embed the SPA (spelled out below).

> **Status:** the Node SEA path below is **built and verified end-to-end** on
> macOS arm64 — the produced binary boots, serves `/api/*`, and serves the SPA
> (`/`, `/assets/*`) in demo mode. It works with **zero edits to `server/src`**
> by shipping `client/dist` alongside the binary.

---

## The core problem

The server locates its assets and optional `.env` **relative to its own file**:

```ts
const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const clientDist  = path.resolve(__dirname, '../../client/dist');   // SPA
const envPath     = path.resolve(__dirname, '../../.env');          // token
```

`express.static` / `res.sendFile` then read those paths from the **real
filesystem** at runtime. A bundler can inline the JS, but it can't make
`express.static` read from inside the binary. So a single binary must either:

1. **ship `client/dist` alongside** the binary at the path the server resolves, or
2. **embed the assets** and have the server serve them from the embedded store
   (needs a small server change — see [Clean approach](#clean-approach-truly-single-file)).

The token is easy either way: the server reads `process.env.YANDEX_TOKEN`
**first**, so you just set that env var (no `.env` needed).

The decisive difference between the two runtimes is **what `__dirname` is inside
the compiled binary**:

| Runtime | `__dirname` at runtime | Alongside `client/dist` resolves? |
|---|---|---|
| **Node SEA** | the **real directory of the executable** | ✅ yes |
| **Bun `--compile`** | a **virtual** root (`/server/dist`) | ❌ no → API-only |

(Both were probed empirically; see the "verified" notes below.)

---

## Approach A — Node 22 SEA (implemented)

`npm run build:binary` → [`scripts/build-binary.mjs`](../scripts/build-binary.mjs).

What it does:

1. Builds `client/dist` if missing.
2. Bundles the server as **CommonJS** (SEA's main must be CJS):
   ```
   esbuild server/src/index.ts --bundle --platform=node --format=cjs \
     --target=node22 --packages=bundle \
     --define:import.meta.url=__IM_URL__ \
     --banner:js='const __IM_URL__=require("url").pathToFileURL(__filename).href;'
   ```
   > **Why the `import.meta.url` define+banner:** esbuild only shims
   > `import.meta.url` for ESM output — for CJS it emits an empty `{}`, so
   > `fileURLToPath(import.meta.url)` would throw `undefined`. We define it from
   > `__filename`, which the SEA sets to the **executable path**. That makes the
   > server compute `__dirname` = the binary's directory. *(verified: without
   > this the binary crashes with `ERR_INVALID_ARG_TYPE`; with it, it boots.)*
3. Generates the SEA blob: `node --experimental-sea-config sea-config.json`.
4. Copies the current `node` binary to `dist/web-namp/server/dist/web-namp` and
   injects the blob with **postject** (sentinel fuse
   `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`).
   - **macOS:** strips the signature, injects into a `NODE_SEA` Mach-O segment,
     then ad-hoc re-signs (`codesign --sign -`). *(verified: skipping the
     re-sign makes macOS SIGKILL the binary — exit 137.)*
   - **Linux/Windows:** plain postject inject (no codesign step).
5. Copies `client/dist` to `dist/web-namp/client/dist`.

### Output & how to run

```
dist/web-namp/
  server/dist/web-namp        ← the executable (node runtime + bundled server)
  client/dist/…              ← the SPA, alongside
```

`__dirname` inside the SEA is `…/server/dist`, so
`path.resolve(__dirname,'../../client/dist')` → `…/client/dist`. The server finds
it. **Ship the whole `dist/web-namp/` folder.**

```bash
./dist/web-namp/server/dist/web-namp                 # demo mode, any cwd
YANDEX_TOKEN=... ./dist/web-namp/server/dist/web-namp # real account
PORT=9000 ./dist/web-namp/server/dist/web-namp        # relocate the port
# open http://localhost:8058
```

Optionally drop a `.env` (`YANDEX_TOKEN=...`) at `dist/web-namp/.env`.

### Limitations

- **No cross-compilation.** A SEA embeds the host's Node, so the binary targets
  the **OS/arch you build on** (this repo's run produced a macOS arm64 binary,
  ~105 MB). To build for the NAS (usually linux/x64), run
  `npm run build:binary` on a linux/x64 Node 22 (e.g. inside
  `docker run --rm -v "$PWD":/app -w /app node:22 ...`), or use Bun (below).
- Not a single *file* — it's a binary + an alongside `client/dist/`. For a true
  single file, embed the assets (below).

---

## Approach B — Bun `bun build --compile`

Bun compiles to a **single file** and **cross-compiles** trivially. Build from
the already-bundled ESM server (or straight from TS):

```bash
# current platform, single file:
bun build server/dist/index.mjs --compile --outfile web-namp

# cross-compile (examples):
bun build server/dist/index.mjs --compile --target=bun-linux-x64   --outfile web-namp-linux-x64
bun build server/dist/index.mjs --compile --target=bun-linux-arm64 --outfile web-namp-linux-arm64
bun build server/dist/index.mjs --compile --target=bun-windows-x64 --outfile web-namp.exe
```

> **Verified caveat:** with the **unmodified** server, a Bun-compiled binary
> **boots and serves `/api/*` but NOT the SPA** — it logs
> `[static] /client/dist not found — API only`. Bun gives `__dirname` a *virtual*
> root, so `../../client/dist` resolves to `/client/dist` (nonexistent). Shipping
> `client/dist` alongside does **not** help (unlike SEA).
>
> To serve the SPA from a Bun binary you must **embed the assets** — which needs
> the small server change below. Bun's smaller size (~59 MB verified) and
> cross-compilation make it the better choice **once that change is in**.

---

## Clean approach (truly single-file)

To get a single file with the SPA **embedded** (no alongside folder, works for
both SEA and — with Bun's embed API — Bun), apply **one small change to
`server/src/index.ts`**. This is owned by another engineer — **specified here,
not applied.**

Replace the static-serving block (the `if (fs.existsSync(clientDist)) { … }`
section near the bottom) with a SEA-asset-aware version:

```ts
// at top of file:
// import sea from 'node:sea';               // Node 22
// (or lazily, to stay safe under tsx/dev where it may be absent)

const inSea = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();

if (inSea) {
  // Serve assets embedded in the binary (registered via sea-config "assets").
  const sea = require('node:sea');
  app.get('*', (req: Request, res: Response) => {
    const rel = (req.path === '/' ? '/index.html' : req.path).replace(/^\/+/, '');
    let data: ArrayBuffer;
    try { data = sea.getRawAsset(rel); }
    catch { data = sea.getRawAsset('index.html'); }      // SPA fallback
    res.type(path.extname(rel) || '.html').send(Buffer.from(data));
  });
  console.log('[static] serving embedded client (SEA assets)');
} else if (fs.existsSync(clientDist)) {
  // …existing express.static + '*' fallback, unchanged…
}
```

Then the SEA config gains an **assets map** enumerating every file in
`client/dist` (the build script can generate this — it already walks
`client/dist`):

```json
{
  "main": "build/sea/server.cjs",
  "output": "build/sea/server.blob",
  "disableExperimentalSEAWarning": true,
  "assets": {
    "index.html":                 "client/dist/index.html",
    "favicon.svg":                "client/dist/favicon.svg",
    "assets/index-BUVw-G5G.css":  "client/dist/assets/index-BUVw-G5G.css",
    "assets/index-CwXNtamj.js":   "client/dist/assets/index-CwXNtamj.js"
  }
}
```

With that change, `build-binary.mjs` would populate `assets` from a directory
walk and drop the "copy client/dist alongside" step — producing a **single
file** with nothing beside it. The same `inSea`-style branch also enables the
Bun path via Bun's embedded-file API (`Bun.embeddedFiles` / static `import`).

> **Lighter alternative** (keeps the alongside layout but makes it relocatable):
> resolve the asset dir from an env override —
> ```ts
> const clientDist = process.env.YANAMP_CLIENT_DIST
>   ? path.resolve(process.env.YANAMP_CLIENT_DIST)
>   : path.resolve(__dirname, '../../client/dist');
> ```
> Then a launcher can point `YANAMP_CLIENT_DIST` anywhere. This does **not**
> embed assets and does **not** fix Bun's virtual-FS case on its own; the SEA
> assets change above is the recommended one for a genuine single file.

---

## Trade-offs at a glance

| | Node SEA (Approach A) | Bun `--compile` (Approach B) |
|---|---|---|
| Status here | ✅ built & verified | ⚠️ boots; SPA needs embed change |
| Single *file* | binary + alongside `client/dist/` | ✅ one file |
| Serves SPA unmodified | ✅ (alongside) | ❌ (virtual `__dirname`) |
| Cross-compile | ❌ build per target | ✅ `--target=…` |
| Size (verified) | ~105 MB | ~59 MB |
| Extra tooling | postject (+ codesign on macOS) | just `bun` |
| Recommended for a clean single file | with the SEA-assets server change | with the embed server change |

**Bottom line:** today, `npm run build:binary` gives you a working self-contained
SEA package with zero source changes. For the smallest, cross-compiled, truly
single-file binary, apply the one-block server change above and prefer Bun.
