# Disaster-Recovery Qualification

`scripts/qualify-local-recovery.sh` provides a bounded, non-destructive check
between routine archive validation and a full replacement-host recovery drill.

```bash
sudo ./scripts/qualify-local-recovery.sh \
  --backups-root /path/to/backups \
  --work-root /path/to/temporary-storage
```

It selects the newest complete app-data set and the newest database-bearing
website set whose compressed SQL dump is below the configured bound. It then:

1. validates manifest type, identifier, ownership, and expected artifacts;
2. tests both gzip streams, calculates read-only SHA-256 digests, and verifies
   every declared version-2 artifact size and checksum;
3. rejects absolute/traversal paths and links that resolve outside the isolated
   restore root;
4. extracts app-data and website files into a random temporary directory;
5. checks that runtime config, panel state, and the website root were restored;
6. starts a resource-limited `mysql:8.4` container with no network or ports;
7. imports the representative SQL dump and confirms application tables exist;
8. deletes the temporary container, extraction, and error output on exit.

The script never connects to production MySQL or Compose networks and never
writes backup artifacts, websites, app-data, DNS, or proxy state.

The restore session retains strict transactional behavior but omits
`NO_ZERO_DATE` and `NO_ZERO_IN_DATE`. This is required for legacy WordPress and
WooCommerce schemas that MySQL can operate after an in-place migration but
would otherwise reject while recreating tables. The production server's global
SQL mode is not changed.

New backups use manifest version 2 with artifact byte lengths and SHA-256
digests. Version-1 backups remain eligible for structural gzip/tar validation
so existing retention sets are not invalidated.

## Remaining Full Drill

This check does not qualify a complete disaster recovery. A replacement-host
drill must still restore all website sets and the coordinated all-databases
dump, start the pinned source release, validate NPM certificates, decrypt panel
integrations, test operator login, exercise representative reads and writes,
and prove RPO/RTO plus DNS rollback. Follow `HIGH_AVAILABILITY.md`.
