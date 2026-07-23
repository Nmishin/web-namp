#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build the web-namp container image and (optionally) save a Synology-importable
# docker-archive tar into dist/.
#
# `docker` is aliased to `podman` in this environment, so we default to podman.
#
# Env overrides:
#   ENGINE    container engine           (default: podman)
#   IMAGE     image ref to build/tag     (default: web-namp:latest)
#   OUTPUT    tar path for `save`        (default: dist/web-namp.tar)
#   SAVE      1 = also write the tar, 0 = build only   (default: 1)
#   PLATFORM  target arch                (default: linux/amd64 — Synology DSM is
#             x86_64; set linux/arm64 for ARM NAS, or empty for the host arch)
#
# Examples:
#   ./scripts/build-image.sh                       # amd64 build + dist/web-namp.tar
#   PLATFORM=linux/arm64 ./scripts/build-image.sh  # for an ARM NAS
#   SAVE=0 ./scripts/build-image.sh                # build only
#   IMAGE=web-namp:1.0 OUTPUT=dist/web-namp-1.0.tar ./scripts/build-image.sh
# ---------------------------------------------------------------------------
set -euo pipefail

ENGINE="${ENGINE:-podman}"
IMAGE="${IMAGE:-web-namp:latest}"
OUTPUT="${OUTPUT:-dist/web-namp.tar}"
SAVE="${SAVE:-1}"
# Synology DSM runs on x86_64, so default the archive to amd64 even when built
# on an arm64 host (cross-built via emulation). Set PLATFORM= (empty) for host arch.
PLATFORM="${PLATFORM-linux/amd64}"

# Resolve repo root from this script's location so it runs from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v "$ENGINE" >/dev/null 2>&1; then
  echo "error: '$ENGINE' not found on PATH. Install podman (or set ENGINE=docker)." >&2
  exit 1
fi

PLATFORM_ARGS=()
if [ -n "$PLATFORM" ]; then
  PLATFORM_ARGS=(--platform "$PLATFORM")
  echo "==> Target platform: $PLATFORM (cross-built via emulation if host differs)"
fi
echo "==> Building image '$IMAGE' with $ENGINE"
"$ENGINE" build "${PLATFORM_ARGS[@]}" -t "$IMAGE" -f Dockerfile "$ROOT"

if [ "$SAVE" != "1" ]; then
  echo "==> Build complete (SAVE=0, skipping tar)."
  echo "    Run it:   $ENGINE run --rm -e PORT=8058 -p 8058:8058 $IMAGE"
  exit 0
fi

mkdir -p "$(dirname "$OUTPUT")"
RAW="$(mktemp -t web-namp-raw.XXXXXX).tar"
trap 'rm -f "$RAW"' EXIT

echo "==> Saving docker-archive"
"$ENGINE" save --format docker-archive -o "$RAW" "$IMAGE"

# Podman stores unqualified names as 'localhost/<name>'. Strip that prefix from
# the archive's RepoTags so the tar imports as a clean '$IMAGE' on Synology.
if command -v python3 >/dev/null 2>&1; then
  echo "==> Stripping 'localhost/' from archive RepoTags -> $OUTPUT"
  python3 - "$RAW" "$OUTPUT" <<'PY'
import sys, tarfile, io, json
src, dst = sys.argv[1], sys.argv[2]
def strip(s): return s.split('localhost/', 1)[-1] if s.startswith('localhost/') else s
tin, tout = tarfile.open(src, 'r'), tarfile.open(dst, 'w')
for m in tin.getmembers():
    data = tin.extractfile(m).read() if m.isfile() else None
    base = m.name.lstrip('./')
    if base == 'manifest.json' and data is not None:
        j = json.loads(data)
        for e in j:
            e['RepoTags'] = [strip(t) for t in (e.get('RepoTags') or [])]
        data = json.dumps(j).encode()
    elif base == 'repositories' and data is not None:
        j = json.loads(data)
        data = json.dumps({strip(k): v for k, v in j.items()}).encode()
    if data is not None:
        ti = tarfile.TarInfo(m.name)
        ti.size, ti.mtime, ti.mode = len(data), m.mtime, m.mode
        tout.addfile(ti, io.BytesIO(data))
    else:
        tout.addfile(m)
tin.close(); tout.close()
# Verify the result is clean.
tags = json.loads(tarfile.open(dst).extractfile('manifest.json').read())[0]['RepoTags']
print('    RepoTags in tar:', tags)
assert not any('localhost/' in t for t in tags), 'localhost/ prefix still present!'
PY
else
  echo "warning: python3 not found — cannot strip 'localhost/' from RepoTags." >&2
  echo "         Writing raw archive; retag after import (see next steps)." >&2
  cp "$RAW" "$OUTPUT"
fi

BYTES=$(wc -c < "$OUTPUT" | tr -d ' ')
echo ""
echo "==> Done. Wrote $OUTPUT (${BYTES} bytes), image tag: $IMAGE"
echo ""
echo "Next steps"
echo "  Local run:      $ENGINE run --rm -e PORT=8058 -p 8058:8058 $IMAGE"
echo "  Copy to NAS:    scp $OUTPUT admin@synology:/volume1/docker/"
echo "  On Synology:    Container Manager > Image > Add > Add From File > $(basename "$OUTPUT")"
echo "                  (or CLI) docker load -i $(basename "$OUTPUT")"
echo "  Then run mapping host 8058 -> container 8058 (see docs/deploy.md)."
echo ""
echo "  NOTE: if 'docker/podman load' ever shows 'localhost/$IMAGE', retag with:"
echo "        docker tag localhost/$IMAGE $IMAGE && docker rmi localhost/$IMAGE"
