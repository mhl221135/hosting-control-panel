# Primary/Standby And Failover

## Scope

This document defines a conservative primary/standby design for Websites V2.
The current release does not provide continuous replication, automatic
promotion, or a quorum system. Its supported baseline is manual disaster
recovery from replicated, verified backups.

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

Use two independent hosts with compatible CPU architecture, Docker Engine,
Compose, time synchronization, and enough storage for the full installation.
Prefer separate power and storage failure domains. A standby on the same disk,
power supply, or filesystem is a backup copy, not host-level resilience.

The standby has:

- the same tagged or committed source release;
- its own uncommitted mode-600 `.env`;
- a stable `UI_SETTINGS_KEY` matching the primary so encrypted integration
  settings remain readable;
- replicated backup sets on storage it can access after primary failure;
- no public DNS target and no running writable stack until promotion.

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
dump instead. Copy only completed backup directories, never `.partial-*`.

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
least as long as the primary retention.

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
