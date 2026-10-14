---
name: render-rules
description: Platform rules and a render.yaml Blueprint checklist for deploying to Render. Use when deploying a service to Render, debugging a Render deploy, or creating or editing a render.yaml file.
---

# Render rules

Source: Cursor Render plugin rules `render-platform` and `render-yaml-checklist`. Claude Code and Codex have no Render plugin, so this skill is their copy.

## Platform
- Bind HTTP servers to `0.0.0.0:$PORT`. See [Port binding](https://render.com/docs/web-services#port-binding).
- The filesystem is ephemeral. Local writes are lost on every deploy, restart, or spin-down. Use a database or object storage. See [Ephemeral filesystem](https://render.com/deploys#ephemeral-filesystem).
- Free web services spin down after 15 minutes of inactivity. Free Postgres databases expire after 30 days. See [Free plan limits](https://render.com/docs/free).
- Render runs Linux, so file paths are case-sensitive. Code that works on macOS or Windows may break if paths are cased incorrectly.
- Deploy one application per service. See [FAQ](https://render.com/docs/faq).
- For common failures, see [Troubleshooting deploys](https://render.com/docs/troubleshooting-deploys).

## render.yaml checklist
- Every service has `name`, `type`, and `runtime` (or `dockerfilePath` for Docker). See [Blueprint spec](https://render.com/docs/blueprint-spec).
- Mark secrets with `sync: false`. Never commit plaintext secret values.
- `fromDatabase` references match a `databases` entry by name.
- Build commands are non-interactive (`npm ci`, not `npm install`). See [Build command](https://render.com/docs/deploys#build-command).
- Web services set `healthCheckPath`. See [Health checks](https://render.com/deploys#health-checks).
- Services that talk to each other are in the same region. See [Private network](https://render.com/docs/private-network).
