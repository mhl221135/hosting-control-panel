# Primary/Standby And Failover

## Scope

This document defines a conservative primary/standby design for Websites V2.
The current release implements machine-local roles and a locked-down standby
runtime, but does not yet provide continuous replication, automatic promotion,
or a quorum system. Its supported data-recovery baseline remains manual
disaster recovery from replicated, verified backups.

Do not run two writable copies of the stack for the same websites. The panel,
WordPress, NPM, MySQL, scheduled backups, and Cloudflare automation all mutate
state. Concurrent primaries can diverge databases, issue conflicting
certificates, overwrite DNS, and run the same scheduled work twice.

## Availability Levels

| Level | Data movement | Expected RPO | Expected RTO | Status |
|---|---|---:|---:|---|
| Backup standby | Completed site and app-data backup sets copied off-host | Last successful replication | 1-4 hours | Supported manually |
| Warm standby | Filesystem snapshots plus MySQL GTID replication | Minutes | 15-60 minutes | Design target |
| Automatic HA | Replicated storage, database quorum, health arbitration, and automatic edge failover | Seconds | Minutes | Out of scope |

RPO is the maximum expected data loss. RTO is the expected restoration time.
Choose targets based on measured website size, database write rate, available
bandwidth, and completed recovery drills.

## Required Topology

Use two independent hosts with Docker Engine, Compose, time synchronization,
and enough storage for the full installation. AMD64 and ARM64 hosts may be
paired because the stack pins multi-architecture images; do not introduce
architecture-specific image prefixes in the promotion path.
Prefer separate power and storage failure domains. A standby on the same disk,
power supply, or filesystem is a backup copy, not host-level resilience.

The standby has:

- the same tagged or committed source release;
- its own uncommitted mode-600 `.env`;
- a stable `UI_SETTINGS_KEY` matching the primary so encrypted integration
  settings remain readable;
- replicated backup sets on storage it can access after primary failure;
- no public DNS target and no running writable stack until promotion.

Install a new replica with:

```bash
sudo ./scripts/install.sh --configure --root /media/ssdmount/websites-v2 \
  --role standby --server-id replica-1
```

The installer stores the authoritative role in
`/etc/hosting-control/role.json`, outside `HOSTING_ROOT`. The marker is mounted
read-only into the panel. In standby mode all normal API mutations return HTTP
423, mutating schedulers and startup migrations are suppressed, and only
`hosting-agent` plus `hosting-ui` are started. Account login, logout and
password changes remain available with read-only health, inventory, statistics
and historical job views. Standby panel state is kept in the machine-local
`/etc/hosting-control/ui-data` directory instead of replicated
`app-data/ui-manager`.

Role, prepared-recovery, and promotion-status files contain only bounded
non-secret metadata and use mode `0644` because the panel runs as an
unprivileged user and mounts them read-only. Connector tokens, management API
tokens, and tunnel rollback state remain mode `0600`.

Do not commit or casually synchronize `.env`, certificates, account state, or
integration keys. Transfer secrets through an encrypted administrative channel.

## State Classification

| State | Standby treatment |
|---|---|
| `sources` | Recreate from Git at the exact tested commit |
| `websites` | Restore site archives, or replicate snapshots one way |
| MySQL databases | Restore `databases.sql.gz`, or use configured GTID replication |
| `app-data/configs` | Restore from `app-data.tar.gz` |
| `app-data/ui-manager` | Restore; requires the matching settings key |
| `app-data/npm` | Restore data and certificate directories as one consistent set |
| `app-data/filebrowser` | Restore if File Browser accounts/settings must persist |
| `app-data/redis` | Optional; treat object-cache data as disposable |
| `app-data/nginx-cache` | Never replicate; FastCGI cache is disposable |
| `imports` | Do not replicate as service state; retain only intentional migrations |
| `backups` and `exports` | Replicate completed directories to independent storage |

Never copy a live MySQL data directory with `rsync`. The application-data
backup deliberately excludes `app-data/mysql` and creates a consistent logical
dump instead. It also excludes disposable Redis persistence and nginx cache
state; both caches are rebuilt after recovery. Copy only completed backup
directories, never `.partial-*`.

## Baseline Backup Standby

1. Schedule per-site backups and application-data backups.
2. Replicate completed backup sets to storage outside the primary host.
3. Verify each manifest, archive with `tar -tzf`, and SQL dump with `gzip -t`.
4. Record the source commit, backup identifiers, and replication completion
   time.
5. Perform a non-production recovery drill at least quarterly and after changes
   to storage layout, MySQL, NPM, or backup code.

Replication must be one way from primary backup storage to standby storage.
Use transfer staging or snapshot semantics so an interrupted copy is not
mistaken for a complete restore point. Keep retention on the destination at
an explicitly measured independent value; it may be lower than primary
retention when replica capacity is constrained.

The initial checksum-verified receiver is available as:

```bash
sudo ./scripts/receive-backups.sh \
  --source backup-reader@primary:/media/seagate/websites-backups-v2 \
  --destination /ssdmount/websites-v2/backups \
  --source-server-id primary-1 \
  --retention 2 --reserve-gb 20 --dry-run
```

Remove `--dry-run` only after reviewing the inventory and capacity result. The
receiver selects the newest completed `app-data` set and then the newest website
set no later than that app-data completion time,
copies missing sets into `.incoming`, validates the version-2 manifest,
declared byte lengths and SHA-256 hashes, checks gzip/tar integrity and archive
path confinement, then atomically promotes each set. Destination retention is
applied independently to every selected group; source deletions are never
mirrored. Older locally verified sets remain until retention is exceeded, but
they are not retransferred on every run. An unchanged local set can reuse its
preceding successful attestation when the source identity, set ID, source and
local manifest checksum, artifact allowlist, and artifact sizes still match.
New or changed sets always receive full checksum and archive validation; a set
ID whose source manifest changed is rejected as an immutable collision. The
deep-verification job remains the independent periodic full-content check and
must be current before standby preparation. A successful run atomically writes mode-`0600`
`receiver-state.json`, containing the bounded source identity and the exact
manifest hash for every retained selected set. A failed or dry run preserves
the previous receipt. The receipt inherits the destination directory's numeric
owner and group so the unprivileged panel can read it without making it group-
or world-readable. Selected group directories and verified sets use that same
owner, with group directories normalized to mode `0750`, so restrictive
root-created parent directories cannot block verification. Use a restricted SSH account that can read only completed
backup directories. Do not grant it Docker, shell administration, website, or
database access.

On the standby panel, run the quick preflight before a drill. Queue **Deep
verification** when full evidence is required. It verifies every set named in
the current receiver receipt and writes `deep-verify-state.json` bound to the
receipt hash. A later receiver run makes the older deep result stale. Neither
operation performs promotion.

The same bounded verifier is available to a host operator without a panel
session. It still refuses any machine whose local marker is not `standby`:

```bash
docker exec hosting-ui node /app/cli/deep-verify.js /srv/backups
```

The example receiver unit uses systemd `OnSuccess` to start the separate
`hosting-backup-deep-verify.service`. A successful deep verification then starts
`hosting-standby-prepare.service`, which refreshes the fenced standby from that
exact receipt-bound recovery point. Both follow-ups run at lower CPU and I/O
priority and only after reception has atomically published a successful receipt.
A deep-verification failure does not invalidate or delete that receiver receipt;
it leaves preparation and promotion blocked until verification succeeds. The
follow-ups use the same host lock as reception and promotion, so those operations
cannot alter or consume a recovery point concurrently. Preparation does not
change the machine role, start public services, or cut over ingress.
The standalone verifier also maintains a bounded mode-`0600`
`deep-verify-progress.json`; the Replication view uses it for running, failed,
and completed set counts without reading system logs.

Deep verification rejects links and special files in website archives. The
app-data archive may contain Certbot's expected relative certificate symlinks,
but each is accepted only when it remains confined to the archive and resolves
to a regular file included in that same archive. Escaping, dangling, chained,
hard, device, FIFO, and other special entries fail verification.

Before creating an app-data archive, the panel invokes one exact, allowlisted
control-agent operation that grants the panel group read access to NPM's
Let's Encrypt tree. The archive operation then fails on every unreadable file;
it must never silently omit certificate private keys. Treat a deep-verification
failure for a dangling `live/` certificate link as an incomplete backup and
create a new app-data set after correcting source permissions.

When a retained set is proven incomplete, move it out of its eligible group
into a sibling quarantine directory and rerun the receiver. Do not rewrite its
manifest or receipt to make it pass. Quarantined sets are intentionally outside
retention and restore selection; remove them separately only after the incident
and replacement recovery point have been reviewed.

For SSH sources, install `scripts/backup-reader-command.sh` as a root-owned
mode-0755 command on the primary, store the single allowed source directory in
root-owned `/etc/hosting-control/backup-reader-root`, and prefix the replica's
public key in the reader account's `authorized_keys` with:

```text
restrict,command="/usr/local/sbin/hosting-backup-reader"
```

The receiver intentionally expects this forced-command protocol. It permits
only bounded inventory output and read-only rsync sender requests beneath the
configured root; it does not grant an interactive shell.
Inventory rows contain the group, set ID, byte size, manifest SHA-256, and
completion epoch required for receipt attestation and app-data cutoff selection.

The measured OPI5 inventory on 2026-08-08 was approximately 74.1 GB for the
two newest sets across all current groups. The initial hp-server policy is
therefore retention `2`, one reception run per day, destination
`/ssdmount/websites-v2/backups`, and a 20 GiB free-space reserve. Re-run the dry
run after large site additions; measured capacity, not this historical figure,
is authoritative.

The hp-server deployment uses the reviewed units in `examples/systemd/`.
`hosting-backup-receiver.timer` runs daily at 05:00 UTC with a bounded random
delay, leaving a multi-hour completion window after the primary backup starts;
successful reception is followed by deep verification and fenced preparation.
`flock` prevents overlap. The services are low-priority, and the receiver has a
read-only system view and can write only the received-backup destination and
its runtime lock. Adjust source addresses and paths before using these example
units on another installation.

Backup set directories are `0750` and their artifacts are `0640`. On the
primary, add the locked forced-command receiver account to the backup writer's
group; do not grant it sudo or interactive shell access. Existing sets created
before this policy must be migrated to the same group-readable modes once.

Each non-dry receiver run atomically maintains mode-`0600`
`receiver-progress.json` with running/succeeded/failed state, bounded set
counts, bounded byte-level transfer progress, and the current backup group. The standby Replication workspace reads
this file directly; it contains no SSH command, path, credential, or error
output. `receiver-state.json` remains the authoritative successful receipt.

The preferred hosting connector is the optional `hosting-cloudflared` Compose
service. Enable it with `HOSTING_TUNNEL_ENABLED=true`, provision the token at
`HOSTING_TUNNEL_TOKEN_FILE` with mode `0400` and owner uid/gid `65532`, and run
the connector on `hosting-net`. It has no host ports, Docker socket, writable
root filesystem, or Linux capabilities. The example host-level systemd unit is
only a bootstrap/fallback path; do not run both connectors after migration.
The existing hp-server administration tunnel remains a separate service and
must not be replaced. Replica service hostnames use the `-r` suffix (for
example, `panel-replica.example.com`); production website hostnames are attached
only during a fenced promotion. Service routes target internal names such as
`hosting-ui:8687`, while promoted website routes target `hosting-nginx:80`.

## Promotion Preconditions

Promotion requires an operator decision. Before starting:

1. Fence the old primary by stopping its stack, disconnecting its public
   network, or revoking its ability to update DNS.
2. Confirm the old primary cannot become writable again automatically.
3. Select one verified recovery point and record its identifiers.
4. Confirm the standby source commit and `.env` match that recovery point.
5. Announce a maintenance window and freeze DNS/security automation elsewhere.

Fencing is mandatory. If the old host cannot be reached, remove its public path
and Cloudflare/API authority before promoting the standby.

## Backup-Based Promotion

After reception is idle, prepare a fenced standby from its newest complete
sets without changing its role or public traffic:

```bash
sudo ./scripts/prepare-standby.sh --dry-run
sudo ./scripts/prepare-standby.sh --apply --confirm PREPARE-STANDBY
```

The command requires the machine-local `standby` role, takes the receiver
lock, requires a successful deep-verification result bound to the current
receiver receipt, refuses unexpected running hosting containers or interrupted staging,
revalidates manifests/checksums/archives, stages extraction, swaps website and
app-data directories, imports the logical all-databases dump into a temporary
replica database runtime, checks it, stops the database again, and records the
recovery point in `/etc/hosting-control/standby-recovery.json`. Failure after
the directory swap restores the prior local standby directories. It does not
promote the role, enable schedulers, or create/switch website tunnel routes.
After database verification it creates, but does not start, the stopped DB,
Redis, PHP-FPM, and internal nginx containers so readiness checks can inspect
the exact promotion runtime without exposing or enabling it.

Website files are selected independently per site, but never from a set whose
`completedAt` is later than the selected app-data snapshot. This prevents a
new overnight website archive from being paired with an older all-databases
dump when backup reception overlaps the primary backup cycle.

Successful preparation writes `/etc/hosting-control/standby-recovery.json`.
That mode-`0600` marker binds the prepared app-data set, website count, source
release, receiver receipt hash, and deep-verification hash. Preflight fails if
any of those inputs changes after preparation.

After the old primary has been externally fenced, a prepared standby can be
promoted to a local primary without changing public ingress:

```bash
sudo ./scripts/promote-standby.sh --dry-run
sudo ./scripts/promote-standby.sh --apply \
  --recovery-id 2026-01-01T00-00-00Z \
  --confirm PROMOTE-STANDBY \
  --fence-confirm OLD-PRIMARY-FENCED
```

Use the exact recovery identifier printed by the dry run. The apply command
rechecks the recovery/deep-verification bindings under the receiver lock,
stops future receiver runs, starts the local runtime, validates MySQL, PHP-FPM,
nginx, and the panel, then atomically changes the machine-local role to
`primary`. A failure before completion restores the standby role and stops the
writable runtime. It writes `/etc/hosting-control/promotion-state.json` with
`public_ingress_cutover:false`. It never changes DNS, Cloudflare routes, NPM
hosts, router forwarding, or tunnel public-hostname routes; those remain an
explicit separately reviewed cutover.

Authenticated role, session, and status responses expose only the bounded
display fields from this marker. After local promotion the panel keeps a
persistent warning visible while `public_ingress_cutover` is false, so a
locally writable server is not mistaken for an already active public origin.

For an operator-reviewed outage, preview local promotion and the exact
Cloudflare hostname changes together, then activate them with one guarded
command:

```bash
sudo ./scripts/activate-standby.sh --preview \
  --hosts-file /etc/hosting-control/failover-hosts.txt \
  --api-token-file /etc/hosting-control/cloudflare-tunnel-api.token

sudo ./scripts/activate-standby.sh --apply \
  --hosts-file /etc/hosting-control/failover-hosts.txt \
  --api-token-file /etc/hosting-control/cloudflare-tunnel-api.token \
  --recovery-id 2026-01-01T00-00-00Z \
  --confirm ACTIVATE-STANDBY \
  --fence-confirm OLD-PRIMARY-FENCED
```

The token file must be a root-owned, non-symlink regular file with mode
`0600`. The wrapper delegates to the same verified promotion and transactional
tunnel-cutover implementations. It does not infer fencing. If the Cloudflare
step fails, its transaction attempts to restore DNS and tunnel configuration;
the locally promoted server stays isolated for operator inspection.

The exact restore commands depend on installation paths and must be rehearsed
on non-production storage. The safe order is:

1. Install or check out the recorded source commit on the standby.
2. Keep the Compose stack stopped.
3. Restore `app-data.tar.gz` into an empty `app-data` directory. It contains
   service state and active configurations but excludes MySQL and nginx cache.
4. Restore every selected website archive into the empty `websites` directory,
   preserving paths and UID/GID `33:33`.
5. Start only `hosting-db`, wait for MySQL readiness, and import the matching
   `databases.sql.gz`.
6. Start internal services without public traffic and validate:

```bash
docker compose up -d hosting-db hosting-redis hosting-php-fpm hosting-nginx
docker exec hosting-nginx nginx -t
docker exec hosting-php-fpm php-fpm -t
docker compose ps
```

7. Start `hosting-ui`, `hosting-files`, and `hosting-phpmyadmin`; inspect panel
   state, site roots, pools, databases, and logs.
8. Start `hosting-npm` only after its restored data, certificates, and database
   agree.
9. Test websites locally using explicit Host headers before changing public
   traffic.
10. Update the edge target, then test HTTP, HTTPS, WordPress login, uploads,
    database writes, scheduled tasks, and one cache purge.

Do not combine a website archive from one backup identifier with a database
dump from another. For a complete-host recovery, use the application-data SQL
dump and website archives from a coordinated, documented recovery window.

## Public Traffic Switching

### Guarded Tunnel Cutover CLI

The first operational tunnel cutover is intentionally a host-level command,
not an automatic failover. Create a root-owned file containing one production
hostname per line, then export a separate least-privilege API token with
**Cloudflare Tunnel Edit**, **Zone Read**, and **DNS Edit** for only the managed
account and zones:

```bash
export CLOUDFLARE_TUNNEL_API_TOKEN='set-in-the-current-root-shell'
sudo -E ./scripts/tunnel-cutover.sh --preview \
  --hosts-file /etc/hosting-control/tunnel-cutover-hosts.txt
```

Preview reads the selected tunnel configuration and exact DNS records without
writing. Apply is available only after `promote-standby.sh` has successfully
changed the local machine to `primary` and written its promotion marker:

```bash
sudo -E ./scripts/tunnel-cutover.sh --apply \
  --hosts-file /etc/hosting-control/tunnel-cutover-hosts.txt \
  --confirm SWITCH-TUNNEL-INGRESS
```

Apply adds or replaces only the selected public-hostname tunnel rules, routes
them directly to `http://hosting-nginx:80`, and changes only their `A`, `AAAA`,
or `CNAME` ingress records to the proxied tunnel target. It preserves the exact
previous tunnel configuration and DNS payloads in the root-only machine-local
`tunnel-cutover.json` receipt. If apply fails, it attempts immediate rollback.
The connector token and management token are never written to that receipt.

A pre-traffic or drill rollback uses:

```bash
sudo -E ./scripts/tunnel-cutover.sh --rollback \
  --confirm ROLLBACK-TUNNEL-INGRESS
```

After a read-only drill, `revert-standby-drill.sh` archives the rolled-back
cutover receipt as `tunnel-cutover.last-drill.json` and removes the active
receipt so a later reviewed failover is not blocked by stale drill state.

This command does not fence the former primary. Fencing remains a separate
mandatory action before local promotion. After public writes reach the promoted
server, failback requires rebuilding the former primary from the new
authoritative state rather than using DNS rollback as a data merge.

For a read-only drill only, after tunnel rollback and after confirming that no
public writes reached the promoted standby, return it to the fenced standby role:

```bash
sudo ./scripts/revert-standby-drill.sh --dry-run
sudo ./scripts/revert-standby-drill.sh --apply \
  --recovery-id 2026-01-01T00-00-00Z \
  --confirm REVERT-STANDBY-DRILL \
  --writes-confirm NO-PUBLIC-WRITES
```

The command refuses active ingress, stops every writable/public hosting service,
atomically restores the machine-local standby role, archives bounded drill
evidence, and re-enables backup reception. Never use it after application or
database writes; that situation requires rebuilding the former primary from the
new authoritative primary.

### Cloudflare DNS

For proxied Cloudflare records, change the origin A/AAAA records to the promoted
host after fencing. Keep both origin addresses in the panel's known IP list, but
do not bulk replace records until the selected zones and old address have been
reviewed. DNS-only records depend on their TTL and client caching.

### One Router And One WAN Address

A router can forward ports 80 and 443 to only one internal destination at a
time. Keep the forwarding target on the active host and change it during
promotion, or place a dedicated HA-capable load balancer in front of both
hosts. Do not expose both NPM instances on the same public address and ports.

### Separate Public Addresses

With independent public addresses, point DNS or a health-checked external load
balancer only at the active host. Automatic health-based switching is not
supported by this stack and must include anti-flap controls and fencing.

## Warm-Standby Design Target

A future warm standby should add all of the following as one coordinated
project:

- unique MySQL `server-id` values, GTID, encrypted replication credentials, and
  monitored replica lag;
- one-way filesystem snapshot replication for websites and non-database
  application data;
- explicit suppression of panel schedulers, certificate issuance, DNS writes,
  backups, and maintenance on the standby;
- a promotion lock and durable role marker outside the replicated dataset;
- a controlled NPM/certificate strategy;
- lag thresholds, health checks, alerting, and an audited promotion command;
- failback that rebuilds the old primary as a new standby instead of merging
  two writable histories.

MySQL binary logging already exists on the primary configuration, but the
current fixed `server-id`, credentials, retention, replica configuration, and
promotion controls are not sufficient to claim replication support.

## Validation After Promotion

- `docker compose ps` reports every intended service running.
- nginx and PHP-FPM configuration tests pass.
- The panel can decrypt integrations and lists primary sites only once.
- NPM hosts point to `hosting-nginx:80` and certificates match their names.
- A read and write test passes for representative WordPress and HTML/PHP sites.
- Cloudflare records resolve to the promoted origin.
- Redis and FastCGI start empty or healthy; cache loss is not treated as data
  loss.
- Backup schedules point to storage independent of the failed host.
- Monitoring and operator notes identify the new primary.

## Failback

Do not reverse DNS while the failed host still contains an older writable
state. Repair or reinstall it, erase or quarantine obsolete service data,
restore/replicate from the current primary, validate it as a standby, and run a
planned promotion using the same fencing checklist.

After every incident or drill, record actual RPO/RTO, failed checks, manual
steps, and documentation changes. Automatic failover should not be introduced
until repeated manual promotions are predictable and measurable.
