@AGENTS.md

# Working on Hubium with Claude Code

The workflow, checks and architecture rules are in [CONTRIBUTING.md](CONTRIBUTING.md). In addition:

- Commits are authored by `Alexander S. <alexander@sharapov.biz>` only, whatever the local git identity: `git -c user.name="Alexander S." -c user.email="alexander@sharapov.biz" commit`.
- Commits carry no Claude co-author trailer and no session link (`.claude/settings.json` turns them off).
- Commit messages state what the change does and why, as facts about the code. They never say who asked for, approved or decided something, never name clients or other people, and give no dates of anyone's statements.
- Larger features start with a written plan that is agreed before any code is written.
- Push only after CI for the previously pushed commit is green: read its conclusion (`gh run view <id> --json conclusion,jobs`), don't assume it.
- Libraries stay on their current versions; problems found along the way are fixed in the same piece of work.
- The DB tests and e2e need PostgreSQL: `docker compose -f docker/compose.dev.yml up -d`, then `pnpm db:migrate`.
