# Contributing to Hubium LMS

Thanks for helping! A few rules keep the codebase healthy.

## Workflow

1. Create a branch from `main`.
2. Make focused commits. Messages describe what changed and why, in plain English.
3. Before pushing, run:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm depcruise && pnpm licenses:check
   ```
4. For UI changes, run the e2e suite against a running app (`pnpm --filter @hubium/e2e e2e`) and check light/dark themes, ru/en and a 375 px viewport. The scenarios change the database of the app they test (users, settings): to keep the development database as it is, run the app on a database of its own (`createdb hubium_e2e`, `DATABASE_URL=…/hubium_e2e pnpm db:migrate && pnpm db:seed --profile demo`, the app started with that `DATABASE_URL`) and the suite with `E2E_DATABASE_URL` set to it.
5. For changes to `docker/`, `deploy/`, `install-hubium.sh`, file uploads or the video pipeline, run the production stack check (CI runs it after installing with `install-hubium.sh` in Docker and natively). It needs ffmpeg and Google Chrome:
   ```bash
   SEED_PROFILE=demo SEED_ADMIN_PASSWORD='Admin12345!' APP_SECRET=$(openssl rand -base64 32) \
     COMPOSE_PROFILES=db,caddy,media,mailpit docker compose -f docker/compose.yml up -d --build --wait
   pnpm --filter @hubium/e2e stack
   ```
   Shell scripts are checked with `shellcheck install-hubium.sh deploy/bin/hubium scripts/bundle.sh`. The site for nginx in front of an installation without Caddy (`docker/nginx.conf`) is checked every night: the nightly CI installs the archive with `--https none` behind Ubuntu's nginx and runs the same checks through it.
6. For changes to local nodes, run their scenarios: `pnpm --filter @hubium/e2e nodes` starts the cloud and two nodes from the built apps (`pnpm build` first) with links the scenarios cut. Changes to how a node is installed, started or updated also go through the lab of a cloud and branch servers installed as in production, which the nightly CI runs: `pnpm --filter @hubium/e2e lab` builds the images, installs the cloud and the nodes with `install-hubium.sh` on servers that are containers with Docker inside, and runs `e2e/lab`. It needs Docker that runs privileged containers, about 25 GB of disk and an hour and a half. `LAB=running` reuses a lab that is up (`node e2e/lab/lab.ts build && node e2e/lab/lab.ts up`), `LAB_KEEP=1` leaves it up, `LAB_REBUILD=1` builds the app's images again; behind a proxy with its own certificate authority, `LAB_BUILD_CA` names its certificate.
7. Releases are cut by pushing a `vX.Y.Z` tag that matches `package.json`; see [docs/releasing.md](docs/releasing.md).

## Architecture rules

- `packages/core` holds business rules and never imports `next` or `react`.
- `modules/*` never import `packages/core`; they receive services through `ctx`.
- The worker never imports UI code.
- Every user-visible string goes into every pack in `packages/i18n/messages/` (ru, en, fr, de, it); module strings into `modules/<module>/messages/`. A test checks that each pack is complete and its placeholders match English. See [docs/i18n.md](docs/i18n.md).
- Permission checks go through `ctx.perm.can()/require()` with code-defined capabilities.
- A change to the data is an operation (`defineOperation`) or a module action, which declares its `offline` policy; side records of page views go through `touch`. Writes outside these belong to a write scope ([docs/architecture.md §1.4](docs/architecture.md)). The e2e suite runs with `HUBIUM_WRITE_GUARD=strict`, which refuses any other write; `report` logs them instead. Time and random numbers inside an operation come from `opNow()` and `opRandom()` (`ctx.random` in modules), so that the cloud can replay what a local node ran.
- Database changes: edit `packages/db/prisma/schema/*.prisma`, then `pnpm db:migrate:dev --name <change>`. The script names the migration after the last one (some are named for a later date) and keeps the indexes Prisma cannot express, which are listed in `packages/db/scripts/raw-indexes.mjs`; add a hand-made index there when a migration creates one. With `--create-only` it creates the migration to edit first, even an empty one for a change of data only, and `pnpm db:migrate` applies it. `pnpm --filter @hubium/db migrate:diff` fails on drift between the schema and the migrated database, and on a missing hand-made index.

## Dependencies

Every installed package must have a license that may ship with an AGPL-3.0 application; CI runs `pnpm licenses:check` against [tools/licenses/policy.json](tools/licenses/policy.json). Packages the application loads (`production`) accept permissive licenses and copyleft that combines with AGPL-3.0 (MPL-2.0, LGPL, GPL-3.0). Build and database tools (`tooling`) may also use licenses that only allow redistribution next to the application, such as EPL-2.0. Proprietary, non-commercial and source-available licenses (BUSL, SSPL, Commons Clause, CC-BY-NC) and GPL-2.0-only are never accepted. When the check fails, find the source with `pnpm why <name> -r` and replace the package, or, after checking the license, add it to the policy with a reason.

## Accessibility

New pages must have no serious or critical axe violations and be usable with the keyboard alone.

## License

By contributing you agree that your contributions are licensed under AGPL-3.0.
