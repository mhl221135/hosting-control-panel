# Encrypted Off-Site Backups

The panel can replicate complete local backup sets from `/srv/backups` to an
independent S3-compatible object store. Restic 0.18.1 encrypts file names,
content, and metadata on the client before upload. The feature is disabled until
an operator configures it.

## Storage And Credentials

Create a dedicated bucket and access key for this installation. Grant only the
object-list, read, write, and delete permissions required inside that bucket or
repository prefix. Do not reuse a Cloudflare, AWS administrator, or personal
credential.

In **Backups -> Encrypted off-site copies**, configure:

- the credential-free HTTPS S3 endpoint, bucket, prefix, and region;
- the dedicated S3 access key ID and secret;
- a new high-entropy Restic repository password;
- daily schedule, snapshot retention, bandwidth limits, and check percentage;
- optional weekly isolated restore tests and a maximum test-set size.

The panel encrypts all three secrets with the existing `UI_SETTINGS_KEY` and
stores them in `app-data/ui-manager/offsite-backup-settings.json`. API responses,
jobs, notifications, and repository status never return the secrets.

Store the Restic repository password and S3 recovery credentials in an
independent password vault. Losing the repository password makes the encrypted
backup unrecoverable. A copy stored only on the protected host is insufficient
for host-loss recovery.

## Repository Lifecycle

1. Save complete settings while scheduled replication is disabled.
2. For a new empty prefix, select **Initialize new repository** and confirm.
3. Select **Sync now**.
4. Inspect the job result, then select **Check repository**.
5. Run **Run restore test** and confirm the measured recovery result.
6. Enable scheduled replication only after those steps succeed.

Do not initialize a prefix that already contains a repository. To attach an
existing repository, save the matching repository password and run **Check
repository** instead.

Sync jobs hold the same storage lock as local backups, restores, exports,
maintenance, and image optimization. Restic therefore sees only coherent local
sets. `.partial-*` and restore-test staging paths are excluded. A successful
sync performs encrypted incremental replication, repository verification,
snapshot retention, and repository pruning no more than once every seven days.
Local and remote retention remain independent.

## Restore Tests

The restore test selects the smallest complete local backup set within the
configured limit, restores that set from the latest encrypted snapshot into an
isolated `offsite-restore-tests/restore-test-*` path, validates its manifest and
non-empty content, records recovery time and byte count, and deletes the path.
It never writes into websites, MySQL, NPM, or live application data.

## Host-Loss Recovery

Clone the repository on a replacement host, build `hosting-ui`, and choose an
empty destination with enough space:

```sh
docker compose build hosting-ui
sudo ./scripts/offsite-recovery.sh /absolute/empty/recovery
```

The script prompts without echo for the S3 secret and repository password. It
lists snapshots, checks repository metadata, requires typed confirmation, and
restores the selected snapshot (default `latest`). It does not read the panel
settings database and does not persist credentials.

After recovery, inspect every `manifest.json`, restore application data during a
maintenance window, and import websites through the documented restore or
migration procedure. Never point the script at a live installation root.

## Operations

Off-site work appears in **Jobs** as `offsite.sync`, `offsite.check`,
`offsite.initialize`, or `offsite.restore-test`. Existing Telegram/SMTP
notifications report bounded summaries without backup payloads.

```sh
docker exec hosting-ui restic version
docker logs --tail 100 hosting-ui
docker compose ps hosting-ui
```

The installation is not protected from primary-host and attached-disk loss
until an independent bucket is configured, a sync and check succeed, recovery
credentials are stored elsewhere, and a restore drill succeeds.
