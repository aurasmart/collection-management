## What & why

## Checklist
- [ ] Matches docs/stage-1-system-design.md and docs/stage-2-ui-ux.md (no silent product/architecture changes)
- [ ] `employer_id` only derived server-side; new tenant tables have RLS + policy + tests
- [ ] No secrets, tokens or PII in code, logs, audit events or frontend env
- [ ] Tests added/updated; `make check` passes
- [ ] OpenAPI contract + generated types updated if the API changed (`make api-types`)
