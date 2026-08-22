# Primary/Standby And Failover

## Scope

This document defines a conservative primary/standby design for Websites V2.
The current release implements machine-local roles, a locked-down standby,
continuous one-way website/runtime-config synchronization, and hourly logical
database recovery points. Promotion is guarded and automatic outage detection
is available as a disabled-by-default watchdog; verified daily backups remain
the disaster-recovery layer. The watchdog never treats connectivity loss as
proof that the old primary is fenced.

The project-managed website `.stignore` excludes generated cache, log,
temporary upgrade, and session paths. Website code, media uploads, plugins,
themes, configuration, and other durable content remain synchronized. This
keeps frequently changing runtime files from indefinitely delaying a zero-lag
standby readiness result.

Standby readiness also requires `receiveOnlyTotalItems` to be zero. If a
standby was seeded from an older restore, reconcile its receive-only changes
to the completed primary index before promotion; stale receiver-only files are
not accepted as a synchronized replica.

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

## Warm Data Path

`hosting-sync` is a project-owned Syncthing container, separate from any
host-level Syncthing service. OPI5 shares `websites`, generated nginx/PHP
runtime configuration, and hourly logical database recovery points as
`sendonly`; hp-server receives them as `receiveonly`. Global discovery and
relays keep the connection usable behind CGNAT, while an optional direct peer
address accelerates transfers on the same LAN.

The warm-sync finalizer installer persists host inotify limits in
`/etc/sysctl.d/90-hosting-syncthing.conf`. Large WordPress trees can exceed
distribution defaults; without the higher limits Syncthing falls back to
periodic scans and reports a filesystem-watcher warning.
The large website folder uses watcher-based immediate detection plus one daily
full safety scan; the much smaller runtime-config and database-recovery folders
retain hourly safety scans. This avoids continuously walking million-file
WordPress trees.

The GUI publication defaults to loopback. If `SYNC_GUI_LISTEN_IP=0.0.0.0` is
used, configure a GUI username and password before publishing port 8834. HTTP
is supported when explicitly selected, but credentials must not be reused.

Live MariaDB files are never synchronized. The primary creates an atomic
compressed `mysqldump` hourly and retains three points under
`HOSTING_ROOT/replication/database`. Promotion requires all three Syncthing
folders to be idle, verifies the newest dump, and imports it before nginx, PHP,
or NPM starts. Daily backup reception remains independent.

The optional automatic watchdog checks the public primary health endpoint
every 30 seconds. After six consecutive failures and a disconnected Syncthing
peer, it verifies that all received folders are complete and that a prepared
recovery point exists. `monitor` mode stops there. `activate` mode additionally
requires a fresh root-owned fencing receipt bound to the configured primary
identity and exact recovery point before it previews and applies the reviewed
Cloudflare cutover. Its hostname file is an explicit allowlist; zones
unavailable to the management token are not silently included.

Install monitoring without activation first:

```bash
sudo ./scripts/install-automatic-failover.sh \
  --health-url https://PRIMARY-PANEL/health \
  --hosts-file /etc/hosting-control/failover-hosts.txt \
  --enable
```

When `UI_DATA_DIR` is customized, also pass
`--panel-state-file UI_DATA_DIR/automatic-failover-state.json` so the standby
Replication view can read the sanitized watchdog state.

After qualification, activation can be armed with `--mode activate` and the
exact machine-local primary server ID. It still cannot invent external fencing:

```bash
sudo ./scripts/install-automatic-failover.sh \
  --health-url https://PRIMARY-PANEL/health \
  --hosts-file /etc/hosting-control/failover-hosts.txt \
  --mode activate --primary-server-id PRIMARY-SERVER-ID --enable
```

Only after the old primary is actually powered off, network-fenced, or
service-fenced, record the short-lived confirmation on the standby:

```bash
sudo ./scripts/record-primary-fence.sh \
  --primary-server-id PRIMARY-SERVER-ID --method power \
  --confirm OLD-PRIMARY-FENCED
```

The mode-`0600` receipt expires after 15 minutes, matches only the currently
prepared recovery ID, and is removed after successful activation. Without it,
the durable watchdog state remains `awaiting-fence`; no role, database, DNS,
tunnel route, or container is changed. Truly unattended promotion therefore
still requires a separately qualified external fencing provider or witness.

For a small installation that explicitly prioritizes availability over strict
split-brain prevention, an emergency `unreachable` policy is also available.
It requires both the primary health endpoint and Syncthing peer to remain down,
the local synchronized state to pass, a minimum three-minute grace period, and
the Cloudflare preview to pass before promotion. Configure it only after the
controlled write/failback drill:

```bash
sudo ./scripts/install-automatic-failover.sh \
  --health-url https://PRIMARY-PANEL/health \
  --hosts-file /etc/hosting-control/failover-hosts.txt \
  --mode activate --primary-server-id PRIMARY-SERVER-ID \
  --primary-sync-device-id PRIMARY-SYNCTHING-DEVICE-ID \
  --auto-qualify-hosts \
  --fence-policy unreachable --unreachable-grace 300 \
  --max-recovery-age 7200 \
  --risk-confirm I-ACCEPT-SPLIT-BRAIN-RISK \
  --panel-state-file UI_DATA_DIR/automatic-failover-state.json \
  --enable
```

This policy makes HP switch the reviewed website routes when OPI5 is powered
off. It cannot distinguish a powered-off host from a network partition. The
peer signal is bound to the exact configured primary Syncthing device ID; an
unrelated connected peer cannot suppress outage detection. The public health
response must also return the configured primary server ID; a healthy but
misrouted panel endpoint is treated as unavailable. The
watchdog refuses promotion when the prepared database recovery point is more
than two hours old; adjust the bound explicitly only when the database snapshot
schedule has a different measured RPO.

With `--auto-qualify-hosts`, each completed warm preparation compares the
candidate checksum with the existing qualification receipt. Changed candidate
sets are previewed against Cloudflare and only ready hosts enter the active
allowlist. Unchanged sets skip provider calls for 24 hours, then refresh zone
eligibility. This discovers new sites without granting authority to blocked or
unavailable zones and never changes DNS during qualification.

The production detector path was qualified on 2026-08-22 without interrupting
website traffic: HP was changed temporarily to monitor mode, only OPI5's panel
health and Syncthing signal were stopped, and HP advanced from two failures to
`threshold-reached` at six consecutive checks. OPI5's nginx, PHP, MySQL, and
NPM remained online. Both signals were restored and HP returned to
`activate`, `healthy`, zero failures, and the durable `standby` role.
The notification delivery worker remains active on a fenced standby while
mutating schedulers and Telegram commands stay disabled. It sends transition-
only Telegram/SMTP alerts for outage detection, blocked activation, activation,
promotion, and recovery rather than repeating alerts on every watchdog poll.
The alert path was qualified on 2026-08-22 with a single failed detector cycle:
Telegram and SMTP each delivered one unreachable warning and one recovery
notice, while OPI5's website services remained online and HP stayed standby.
The complete automatic path was then qualified with a temporary two-host
allowlist. OPI5's panel-health and exact Syncthing-peer signals were stopped,
while its nginx and NPM continued serving all unrelated hosts. After six
failures and the five-minute grace, HP promoted recovery
`2026-08-22T08-43-19Z`, applied and read-after-write verified the two selected
Cloudflare routes, reached `promoted-unreachable`, and served the selected
site through the HP tunnel. The routes were rolled back, OPI5's signals and
safety timers were restored, and HP returned to fenced standby with no public
writes. This proved the bounded automatic path. The later operator-controlled
111-host write/failback drill is recorded in the Failback section; fully
unattended all-host promotion remains intentionally unqualified without an
external quorum witness.
promotion receipt therefore records `PRIMARY-UNREACHABLE-RISK-ACCEPTED`, not
`OLD-PRIMARY-FENCED`. Once HP has promoted, do not let a recovered OPI5 resume
as writable; rebuild and fail back from HP's authoritative data.

Install the non-reversing peer fence on the current primary:

```bash
sudo ./scripts/install-former-primary-fence.sh \
  --peer-health-url https://REPLICA-PANEL/health \
  --peer-server-id REPLICA-SERVER-ID --enable
```

Fifteen seconds after boot and every 30 seconds thereafter, OPI5 checks HP's
no-store health response. It acts
only when the expected HP server reports `primary` together with a durable
`promoted` or `promoted-unreachable` watchdog state. OPI5 then disables its
database-replication/finalizer timers and stops the panel, Syncthing, nginx,
PHP, database, Redis, billing, file, phpMyAdmin, and agent containers.
`hosting-npm` deliberately remains running for unrelated proxy hosts. This
fence never starts services or auto-unfences; rebuild/failback remains an
explicit operator workflow.

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
- `HOSTING_SYNC_PEER_DEVICE_ID` set to the primary Syncthing device ID, so an
  unrelated connected peer cannot satisfy panel replication readiness;
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
docker exec hosting-ui flock -n /srv/backups/.deep-verify.lock \
  node /app/cli/deep-verify.js /srv/backups
```

The example receiver unit uses systemd `OnSuccess` to start the separate
`hosting-backup-deep-verify.service`. A successful deep verification then starts
`hosting-standby-prepare.service`, which refreshes the fenced standby from that
exact receipt-bound recovery point. Both follow-ups run at lower CPU and I/O
priority and only after reception has atomically published a successful receipt.
Preparation reports bounded per-site extraction progress and its database
restore phases in the systemd journal.
A deep-verification failure does not invalidate or delete that receiver receipt;
it leaves preparation and promotion blocked until verification succeeds. The
follow-ups use the same host lock as reception and promotion. Verification also
holds an in-container lock so a disconnected `docker exec` cannot leave an
untracked verifier racing a later run. Those operations therefore cannot alter
or consume a recovery point concurrently. Preparation does not
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
counts, bounded byte-level transfer progress, and the current backup group. It
publishes a fresh running state before remote inventory discovery, then adds
transfer totals after selection. The standby Replication workspace reads this
file directly; it contains no SSH command, path, credential, or error output.
`receiver-state.json` remains the authoritative successful receipt.

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

Before nginx starts, promotion normalizes only the two mount-root permissions
needed by runtime workers: the websites root is traversable and the nginx cache
root is root-owned and traversable. It does not rewrite site file permissions.

Authenticated role, session, and status responses expose only the bounded
display fields from this marker. After local promotion the panel keeps a
persistent warning visible while `public_ingress_cutover` is false, so a
locally writable server is not mistaken for an already active public origin.
The hourly database-dump timer remains disabled during isolated local
promotion and read-only drills. It is enabled only after the reviewed public
tunnel cutover succeeds; drill reversion disables it again.
The standby finalizer timer is disabled for every promotion and restored only
when a no-write drill is explicitly reverted to standby.

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
tunnel-cutover implementations. A successful preview prints only bounded host
and record counts instead of the complete production DNS inventory. It does
not infer fencing. If the Cloudflare
step fails, its transaction attempts to restore DNS and tunnel configuration;
the locally promoted server stays isolated for operator inspection.
Apply is recorded as active only after a read-after-write check confirms one
matching tunnel ingress rule and one matching proxied DNS ingress record for
every selected hostname. A mismatch enters the same immediate rollback path.
Watchdog-triggered success output is suppressed so systemd journals do not
receive the full hostname and Cloudflare zone inventory; bounded errors remain.

Each successful standby preparation derives every website hostname and alias
from the restored `sites.map` and writes a mode-`0600`, recovery-bound candidate
inventory at `/etc/hosting-control/failover-hosts.candidates.txt`. Newly backed
up websites therefore appear automatically, but they are not automatically
authorized for public cutover. Preparation fails and reports all missing roots
if any mapped website directory was not restored or is a symlink. Review the
exact additions and removals, then accept them for the displayed recovery point:

```bash
sudo ./scripts/review-failover-hosts.sh --preview
sudo ./scripts/review-failover-hosts.sh --apply \
  --recovery-id 2026-01-01T00-00-00Z \
  --confirm ACCEPT-FAILOVER-HOSTS
```

Apply atomically updates `/etc/hosting-control/failover-hosts.txt`. It does not
change DNS, tunnel routes, containers, or machine role. Use that reviewed file
as `activate-standby.sh --hosts-file` only after the primary is fenced.

When some prepared hostnames are outside the configured Cloudflare account,
qualify the complete candidate inventory and accept only provider-ready hosts:

```bash
sudo ./scripts/qualify-failover-hosts.sh --preview
sudo ./scripts/qualify-failover-hosts.sh --apply \
  --recovery-id RECOVERY-ID \
  --confirm ACCEPT-QUALIFIED-FAILOVER-HOSTS
```

Both commands use Cloudflare's preview path only. Apply atomically replaces the
local automatic-failover allowlist with the ready subset and records a bounded
qualification receipt; it does not change DNS or tunnel routes.
The automatic watchdog verifies that the current prepared recovery owns the
candidate inventory and that its checksum, the accepted allowlist checksum,
and both hostname counts match the qualification receipt. An unchanged
candidate inventory remains qualified across newer database recovery points;
missing, edited, or changed inventories stop at `blocked-host-qualification`.
If the watchdog is interrupted after public cutover but before its final state
write, the next timer run reconstructs `promoted` from the matching durable
local-promotion and active tunnel-cutover receipts. It never infers promotion
from the role marker alone.
If local promotion succeeded but the Cloudflare transaction rolled back, the
machine remains an isolated primary and the next timer run retries only the
qualified tunnel/DNS transaction. The recovery ID and current qualification
receipt must still match. The retry does not restore SQL or repeat local
promotion. An `active` cutover receipt repairs an interrupted
`public_ingress_cutover` flag; a `rollback-failed` receipt is never replaced
automatically because its public state is uncertain.
Activation preview exits with failure when any selected hostname is blocked,
even though it prints the full non-mutating plan for operator review.

The exact restore commands depend on installation paths and must be rehearsed
on non-production storage. The safe order is:

For the normal warm-replica path, do not restore daily website archives over
the synchronized tree. After all Syncthing folders report exact zero backlog
and zero receive-only drift, prepare the synchronized state with:

```bash
sudo ./scripts/prepare-warm-standby.sh --dry-run
sudo ./scripts/prepare-warm-standby.sh --apply --confirm PREPARE-WARM-STANDBY
```

This verifies the latest hourly logical database recovery point and writes the
promotion/failover inventory markers without changing files, databases,
services, role, DNS, or tunnel routes. `prepare-standby.sh` remains the slower
archive-based disaster-recovery workflow.

For the initial multi-hour baseline, install the resumable one-shot finalizer
on each side. It survives reboot and never promotes or changes public traffic:

```bash
sudo ./scripts/install-warm-sync-finalizer.sh --source   # primary only
sudo ./scripts/install-warm-sync-finalizer.sh --standby  # standby only
```

The source publishes a release-bound completion marker only after its index is
idle and error-free. The standby then reverts stale receive-only drift to that
authoritative index, waits for exact zero backlog, and runs warm preparation.
Successful install and upgrade runs atomically stamp `.source-release` from the
checked-out Git commit. Reviewed patched deployments can set
`HOSTING_SOURCE_RELEASE` explicitly before invoking the stamping helper.
While waiting, it rereads the release marker each cycle so a source update does
not leave a long-running standby finalizer pinned to an obsolete release.
The revert uses Syncthing's receive-only `/rest/db/revert` operation; it does
not override the primary's global folder state.
Reconciliation covers website files, runtime configuration, and database
recovery snapshots, including changes published while standby replication was
intentionally stopped for a drill.
On the standby, a ten-minute timer repeats this bounded finalization. When a
new hourly database snapshot arrives, it starts only MariaDB, imports that
snapshot into the private standby volume, records its checksum-bound recovery
ID, and stops MariaDB again. Unchanged snapshots are skipped. Promotion uses
the pre-staged volume and refuses a newer, not-yet-prepared snapshot, avoiding
a full SQL import during the outage.
After a database import, the finalizer waits for all folders to become exact
again before recording preparation, covering changes that arrived during import.
The standby installer also enables `hosting-standby-fence.service`. After each
Docker/host reboot it stops database, PHP, nginx, NPM, billing, file-manager,
and phpMyAdmin services whenever the machine-local role is still `standby`;
sync, agent, panel, and cloudflared remain available.

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
A completed `rolled-back` receipt is archived automatically before a later
apply. An `active` or `rollback-failed` receipt still blocks replacement and
requires explicit operator recovery.

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
balancer only at the active host. Health loss alone is not fencing; automatic
switching must remain behind the receipt gate unless a qualified external
fencing provider or witness supplies equivalent evidence.

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

The guarded rebuild half is implemented by `scripts/rebuild-former-primary.sh`
on the promoted primary and `scripts/accept-former-primary-rebuild.sh` on the
durably fenced former primary. Its dry run verifies promotion/cutover state,
the remote fence, mutual SSH, and fixed Syncthing identities. Apply reverses
all three managed Syncthing folders and creates a
final logical database recovery point. Database recovery and runtime
configuration must be exact; website-file lag may remain only when it is
error-free, conflict-free, and no more than 100 items or 10 MiB. The former
primary stages the exact database recovery and the rebuild records a bounded
receipt without changing public ingress.

Traffic failback is implemented separately by `scripts/complete-failback.sh`.
HP remains online while a live logical database snapshot transfers and OPI5
pre-imports it. OPI5 starts and validates its runtime before Cloudflare restores
the recorded direct records. HP remains online for a 60-second ingress grace,
then demotes to receive-only standby. This availability-first overlap can lose
writes made on HP after the final logical snapshot; it deliberately favors
continuous service over zero-RPO failback. The former-primary fence timer is
paused before OPI5 changes role, restored if promotion fails, and re-armed only
after HP has demoted to standby.

The full 111-host write/failback drill completed on 2026-08-22. A database and
filesystem write made on promoted HP was present after OPI5 restoration, all
111 managed hostnames returned non-5xx responses after failback, OPI5 resumed
`sendonly` website synchronization and scheduled database snapshots, and HP
returned to `receiveonly` standby with its outage watchdog active. The drill
also established that active website service must never be stopped while
waiting for a website-tree rescan or standby SQL import.

After every incident or drill, record actual RPO/RTO, failed checks, manual
steps, and documentation changes. Automatic failover should not be introduced
until repeated manual promotions are predictable and measurable.
