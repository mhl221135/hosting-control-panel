# Wix DNS WAN-IP updater

This temporary standalone script is installed as `/root/wix-ddns.py` on OPI5.
It updates only explicitly listed existing Wix A records when OPI5's public
IPv4 changes. The panel integration remains in `TODO.md`.

Create `/root/wix-ddns.json` as root, mode `0600`, using this shape:

```json
{
  "sites": [
    {
      "domain": "example.com",
      "account_id": "WIX_ACCOUNT_ID",
      "api_key": "WIX_ACCOUNT_API_KEY",
      "hosts": ["@"]
    }
  ]
}
```

`@` updates the apex A record. To update another A record, list its full name
in `hosts`, for example `"www.example.com"`. Do not list `www` when it is a
CNAME to the apex; it follows the apex automatically. Each Wix account needs
its own account ID and account-level API key with Domain DNS access. The Wix
Domain DNS API works only for Wix-registered domains or external domains whose
nameservers point to Wix, not domains connected to Wix by pointing.

Run a read-only preview first:

```bash
sudo /usr/bin/python3 /root/wix-ddns.py
sudo /usr/bin/python3 /root/wix-ddns.py --apply
```

After a successful manual apply, add a root cron entry if desired:

```cron
*/10 * * * * /usr/bin/python3 /root/wix-ddns.py --apply >>/root/wix-ddns.log 2>&1
```

The script skips all work unless this host is marked primary and holds a fresh
independent-witness lease. It reads the public IPv4 from ipify over HTTPS,
compares Wix's live DNS-zone record, and sends a Wix PATCH only if that A
record differs. It preserves other DNS records and the A record's TTL. Missing
or ambiguous A records fail closed. Wix DNS propagation can take time after an
accepted update. API keys stay in `/root/wix-ddns.json`; never add that file
to Git or website backups.
