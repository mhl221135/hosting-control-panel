#!/usr/bin/env python3
"""Update selected Wix A records to this primary host's public IPv4 address."""

import argparse
import ipaddress
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


CONFIG = "/root/wix-ddns.json"
ROLE = "/etc/hosting-control/role.json"
WITNESS = "/etc/hosting-control/witness-primary-state.json"
LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def read_json(path):
    with open(path, encoding="utf-8") as file:
        return json.load(file)


def primary_has_lease():
    role = read_json(ROLE)
    witness = read_json(WITNESS)
    if role.get("role") != "primary" or witness.get("status") != "leased":
        return False
    expires = datetime.fromisoformat(witness["leaseExpiresAt"].replace("Z", "+00:00"))
    return expires > datetime.now(timezone.utc)


def public_ip():
    with urllib.request.urlopen("https://api.ipify.org", timeout=15) as response:
        value = response.read(64).decode("ascii").strip()
    address = ipaddress.IPv4Address(value)
    if not address.is_global:
        raise ValueError("WAN IPv4 is not globally routable")
    return str(address)


def wix_request(domain, account_id, api_key, method="GET", payload=None):
    url = "https://www.wixapis.com/domains/v1/dns-zones/" + urllib.parse.quote(domain)
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": api_key,
        "wix-account-id": account_id,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Wix API returned HTTP {error.code} for {domain}") from None


def valid_domain(value):
    domain = str(value).lower().rstrip(".")
    if len(domain) > 253 or "." not in domain or not all(LABEL.fullmatch(label) for label in domain.split(".")):
        raise ValueError(f"Invalid domain: {value!r}")
    return domain


def update_site(site, ip, apply):
    domain = valid_domain(site["domain"])
    account_id = site["account_id"]
    api_key = site["api_key"]
    if not isinstance(account_id, str) or not account_id or not isinstance(api_key, str) or not api_key:
        raise ValueError(f"Missing Wix account ID or API key for {domain}")
    hosts = site.get("hosts", ["@"])
    if not isinstance(hosts, list) or not hosts:
        raise ValueError(f"Invalid hosts for {domain}")
    zone = wix_request(domain, account_id, api_key)["dnsZone"]
    records = zone.get("records", [])
    changes = []
    for host in hosts:
        name = domain if host == "@" else valid_domain(host)
        if name != domain and not name.endswith("." + domain):
            raise ValueError(f"Host {name} is outside {domain}")
        matches = [record for record in records if record.get("type") == "A"
                   and str(record.get("hostName", "")).lower().rstrip(".") == name]
        if len(matches) != 1 or not isinstance(matches[0].get("values"), list):
            raise ValueError(f"Expected exactly one existing A record for {name}")
        old = matches[0]
        if old["values"] == [ip]:
            print(f"{name}: unchanged ({ip})")
            continue
        old_record = {"type": "A", "hostName": old["hostName"],
                      "ttl": old["ttl"], "values": old["values"]}
        changes.append((name, old_record, {**old_record, "values": [ip]}))
    if not changes:
        return
    for name, old, new in changes:
        print(f"{name}: {old['values']} -> {ip}" + ("" if apply else " (dry run)"))
    if apply:
        wix_request(domain, account_id, api_key, "PATCH", {
            "domainName": domain,
            "deletions": [old for _, old, _ in changes],
            "additions": [new for _, _, new in changes],
        })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write changed Wix A records")
    parser.add_argument("--config", default=CONFIG)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Run as root")
    if not primary_has_lease():
        print("Skipped: this host is not the leased primary")
        return
    info = os.stat(args.config, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("Config must be a root-owned regular file with mode 0600")
    sites = read_json(args.config)["sites"]
    if not isinstance(sites, list):
        raise ValueError("Config sites must be a list")
    if not sites:
        print("No Wix domains configured")
        return
    ip = public_ip()
    failed = 0
    for site in sites:
        try:
            update_site(site, ip, args.apply)
        except (KeyError, ValueError, OSError, RuntimeError, TypeError) as error:
            print(f"wix-ddns: {error}", file=sys.stderr)
            failed += 1
    if failed:
        raise RuntimeError(f"{failed} Wix domain(s) failed")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, RuntimeError, TypeError) as error:
        print(f"wix-ddns: {error}", file=sys.stderr)
        sys.exit(1)
