# Releasing Hubium LMS

A release is built and published by CI from a git tag; nothing is uploaded by hand.

## What a release contains

| File | What it is |
|---|---|
| `ghcr.io/sharapov-outsource/hubium-lms:<version>` | web server, worker and the `hubium` command, for amd64 and arm64 |
| `ghcr.io/sharapov-outsource/hubium-lms-media:<version>` | the same with ffmpeg, running the video transcoding worker |
| `hubium-<version>-linux-x64.tar.gz`, `…-linux-arm64.tar.gz` | the whole system in one archive, Node.js included (plain JavaScript, nothing obfuscated) |
| `install-hubium.sh` | the installer, with the release's version written in |
| `compose.yml`, `Caddyfile`, `env.production.example` | the Docker installation without the script |
| `nginx.conf` | the site for nginx in front of an installation without Caddy (`--https none` fills it in) |
| `SHA256SUMS` | checksums of every file above |

Images and archives come from one Dockerfile and one layout script (`scripts/bundle.sh`), so `/opt/hubium` in an image and an unpacked archive hold the same files. The archive layout:

```
bin/hubium          launcher: web | worker | the CLI (hubium help)
node/               Node.js from the official image, with its licence
web/                Next.js standalone server, static files, public/
worker/             the bundled worker
cli/                the bundled hubium command and migrations/*.sql
deploy/             systemd units, Caddyfile, nginx.conf, compose.yml, settings examples
LICENSE, VERSION, README.txt
```

Each architecture is built on its own runner (no emulation): sharp in the web server is a native module.

## Cutting a release

1. Set the version in the root `package.json`, for example `1.2.0` or `1.2.0-rc.1`, and commit it.
2. Tag the commit and push the tag:

   ```bash
   git tag -a v1.2.0 -m "Hubium LMS 1.2.0"
   git push origin v1.2.0
   ```

3. Watch the Release workflow. A tag that does not match `package.json` fails at once.

Tags with a suffix (`-rc.1`, `-beta.2`) become GitHub pre-releases. Their images get the exact version only; a release `1.2.0` also moves `1.2`, `1` and `latest`.

## What the workflow does

`.github/workflows/release.yml`, on a `v*` tag:

1. **verify**: the tag equals `package.json`'s version.
2. **ci**: the whole CI workflow (`ci.yml` via `workflow_call`). This covers lint, types, unit tests and e2e. It also installs from source with `install-hubium.sh` in Docker and natively, runs the production-stack checks on both and migrates PostgreSQL 16.
3. **build** (amd64 and arm64): the two images, pushed by digest only (no tags yet), with SBOM and provenance; the archive.
4. **test-install** (both architectures, Docker and native): a fresh runner installs exactly these images and archives with `install-hubium.sh`, signs in through the API, runs `hubium doctor` and upgrades in place.
5. **publish**:
   - tags the multi-architecture images;
   - attests the archives (`actions/attest-build-provenance`);
   - creates the GitHub release with the files above and generated notes.

If any step fails, nothing is tagged or released; the digests pushed in step 3 stay untagged.

## Verifying a download

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify hubium-1.2.0-linux-x64.tar.gz --repo sharapov-outsource/hubium-lms
docker buildx imagetools inspect ghcr.io/sharapov-outsource/hubium-lms:1.2.0 --format '{{json .Provenance}}'
```

`install-hubium.sh` checks every file it downloads against `SHA256SUMS`.

## Once, when the repository becomes public

- Packages pushed from a private repository are private. Make `hubium-lms` and `hubium-lms-media` public under **Packages → Package settings → Change visibility**, so that `docker pull` works without signing in.
- Check that the packages are linked to the repository (the images carry `org.opencontainers.image.source`).

## Testing the installer before a release

- `bash install-hubium.sh --help` and `--dry-run` work anywhere: on macOS, run it in a Debian container.
- `shellcheck install-hubium.sh deploy/bin/hubium scripts/bundle.sh` runs in CI.
- `--from-dir DIR` installs files from a directory instead of a release:
  - for native mode, the archive from `docker buildx build -f docker/Dockerfile --target bundle --output type=local,dest=DIR .`;
  - for Docker mode, `compose.yml` and `Caddyfile` (and `nginx.conf` with `--https none`), with `--image`/`--no-pull` for locally built images.

  CI's `docker` and `native` jobs install this way on every push.
