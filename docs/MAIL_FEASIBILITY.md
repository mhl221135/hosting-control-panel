# Mail Platform Feasibility

The mail platform remains a planned, separately owned stack. Do not deploy
Stalwart, Roundcube, or migrate mailboxes until the hard infrastructure gates
in this document pass.

## Read-Only Preflight

Run target-host checks on the intended server:

```bash
sudo ./scripts/mail-feasibility.sh \
  --mode host \
  --region us-east-1 \
  --expected-wan-ip 203.0.113.10 \
  --mail-hostname mail.example.com \
  --data-path /path/to/mail-data \
  --backup-path /path/to/independent-backups
```

Run AWS checks on a trusted administrator workstation with short-lived AWS
credentials:

```bash
./scripts/mail-feasibility.sh --mode aws --region us-east-1
```

Do not copy broad AWS credentials to the hosting server for this check.
`mail-control` will eventually require its own least-privilege runtime identity.

The script prints no public IP, PTR target, AWS account ID, identity ARN,
domains, credentials, or provider response bodies. It exits `2` for a hard
failure and `0` for either a conditional result or a clean pilot gate. Read the
verdict; warnings are intentionally not treated as production approval.

## What It Proves

- supported host architecture and required diagnostic commands;
- free space on the planned primary and independent backup filesystems;
- public IPv4 presence and, when pinned, expected-address equality;
- PTR equality when the intended mail hostname is provided;
- local availability of TCP 25, 587, and 993;
- outbound connectivity to the regional SES SMTP endpoint;
- clock synchronization;
- active AWS authentication, SES production/sending status, quota visibility,
  and identity-list permission.

## What It Cannot Prove

Inbound TCP reachability must be tested from an independent Internet host after
temporary listeners exist. One WAN observation cannot prove that an address is
static. The preflight also cannot prove ISP policy, forward-confirmed reverse
DNS, mail reputation, spam filtering, abuse response, SES event handling,
backup consistency, mailbox migration, or restore correctness.

Passing this preflight authorizes only design and an isolated non-production
pilot. The complete rollout and acceptance criteria remain in `TODO.md`.
