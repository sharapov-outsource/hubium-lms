# Contributing to Hubium

Thanks for helping! A few rules keep the codebase healthy.

## Workflow

1. Create a branch from `main`.
2. Make focused commits. Messages describe what changed and why, in plain English.
3. Before pushing, run:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm depcruise
   ```
4. For UI changes, run the e2e suite against a running app (`pnpm --filter @hubium/e2e e2e`) and check light/dark themes, ru/en and a 375 px viewport.

## Architecture rules

- `packages/core` holds business rules and never imports `next` or `react`.
- `modules/*` never import `packages/core`; they receive services through `ctx`.
- The worker never imports UI code.
- Every user-visible string goes into `packages/i18n/messages/{ru,en}.json`; a test enforces key parity.
- Permission checks go through `ctx.perm.can()/require()` with code-defined capabilities.
- Database changes: edit `packages/db/prisma/schema/*.prisma`, then `pnpm db:migrate:dev --name <change>`.

## Accessibility

New pages must have no serious or critical axe violations and be usable with the keyboard alone.

## License

By contributing you agree that your contributions are licensed under AGPL-3.0.
