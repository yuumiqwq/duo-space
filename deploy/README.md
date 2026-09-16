# 11scat-web deployment

The Git repository is now `yuumiqwq/duo-space`. Its image location is now
`ghcr.io/yuumiqwq/11scat-web`: the transferred repository's Actions token cannot
publish to the old owner's package. The workflow, VPS deployer, and rollback
allowlist are updated together in this repository. Existing images under
`ghcr.io/yuumi-11/11scat-web` remain valid rollback targets.

GitHub Actions builds each `main` commit and pushes two GHCR tags:

- `ghcr.io/yuumiqwq/11scat-web:<full-git-sha>` (immutable deployment tag)
- `ghcr.io/yuumiqwq/11scat-web:latest` (current branch head)

## Required VPS migration after the repository transfer

An operator with normal VPS SSH access must replace the three installed scripts
`/opt/11scat-web/ci-deploy.sh`, `/opt/11scat-web/deploy.sh`, and
`/opt/11scat-web/rollback.sh` with this repository's corresponding `deploy/`
files, preserving their executable permissions. Keep the existing forced-command
SSH restriction, `identity.env`, deployment state, and `/opt/11scat-data` intact.
Then rerun the failed `deploy` job for the desired exact commit.

The CI key can invoke deployment only; it cannot install these script updates.
Until the operator updates the installed files, the old deployer still attempts
to pull from the old package location and automatic deployment will fail before
replacing the running application. Repository synchronization and image publishing
can succeed independently of this VPS migration.

The VPS does not build application images and does not retain source releases or
deployment archives. Persistent application data remains at
`/opt/11scat-data:/data`. Secrets remain only in
`/opt/11scat-web/identity.env`.

Room-drive files live under `/opt/11scat-data/cloud-drive` through the same
`/data` bind mount. The current 30 GB VPS uses
`CLOUD_DRIVE_LIMIT_BYTES=5368709120` (5 GiB); application writes stop at 90% so
Docker and the operating system retain recovery space.

The package stays private. GitHub Actions connects with a dedicated SSH key that
is forced server-side to run only `ci-deploy.sh`. The workflow's short-lived
`GITHUB_TOKEN` is streamed to that command for the GHCR pull and held in a
temporary Docker configuration directory, which is deleted when deployment
finishes. No persistent GHCR credential is stored on the VPS.

## Deploy

Copy the scripts to `/opt/11scat-web`, then run as root:

```bash
/opt/11scat-web/deploy.sh <full-git-sha>
```

The script refuses to deploy when `/` is at least 85% full. It pulls the exact
SHA image, tests it on `127.0.0.1:3101`, verifies the `/data` bind mount, replaces
the production container on `127.0.0.1:3100`, checks both the local and public
HTTP endpoints, and restores the old image automatically if verification fails.

After success, only the current and immediately previous application images are
retained. Cleanup is restricted to stopped containers beginning with known
`11scat-web` deployment prefixes, the local/GHCR `11scat-web` image repositories,
`/tmp/11scat-*`, and legacy artifacts directly inside `/opt/11scat-web`.
No global Docker prune command is used.

## Background task recovery

The production Node process resumes persisted task updates without a browser.
It checks due operations 15 seconds after each round, using the same store,
queues, receipts and retry deadlines as authenticated requests. Restarting the
container retains accepted operations through the existing `/data` mount.

Before each round the scheduler requests `/api/access/runtime` at
`TASK_SYNC_ORIGIN`, defaulting to `https://study.11scat.xyz`, and requires the
returned instance ID to match its own. The candidate on port 3101 therefore
does not process the shared data: the public route still serves production.
An unreachable origin also prevents a round. Reading the endpoint alone does
not activate scheduling; it exposes only an instance ID and runtime timestamps.
Check `active` and `lastRunAt` after promotion to verify the scheduler is running.
This gate assumes the existing single production instance, not load balancing
between several writers. `TASK_SYNC_DISABLED=1` disables this scheduler.

## Roll back

```bash
/opt/11scat-web/rollback.sh
```

The rollback target is tested on port 3101 before the production container is
recreated. The same environment file, persistent data mount, log limits, and
health checks are used. The current and previous image references are then
swapped, so the operation can be reversed once more if required.

## Voice transcription configuration

This optional setup procedure is preserved from the 2026-09-08 transcription notes. It describes how to configure a deployment; it does not assert that an account is currently missing configuration or that a device test has passed.

1. Confirm that the selected Cloudflare account uses the Workers AI Free plan. Create a dedicated API token restricted to that account with Workers AI Read and Workers AI Edit permissions.
2. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_WORKERS_AI_TOKEN` in `/opt/11scat-web/identity.env`. Set `CLOUDFLARE_AI_FREE_PLAN_CONFIRMED=true` only after checking the account plan; variable names are also listed in [identity.env.example](identity.env.example). Keep real credentials on the server.
3. Use the existing deployment procedure to recreate the application container so it reads the environment file. With an authorized short Chinese recording, check the first transcription and subsequent cached result; use the relevant phone for device-specific verification.

The server calls the Workers AI REST API without deploying an additional Worker. Historical plan comparisons and licensing evidence are in [the voice research archive](../docs/archive/research/voice-and-browser.md); current behavior remains in [the functionality document](../docs/current-functionality.md). This application does not upgrade the account plan or fall back to a paid service.
