#!/bin/sh

set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"

env_value() {
  awk -v key="$1" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      if (value ~ /^".*"$/ || value ~ /^'\''.*'\''$/) value = substr(value, 2, length(value) - 2)
      print value
      exit
    }
  ' "$env_file"
}

hosting_root="$(env_value HOSTING_ROOT)"
hosting_root="${hosting_root:-/media/ssdmount/websites-v2}"
target="$hosting_root/app-data/configs/nginx/conf.d/default.conf"

[ -f "$target" ] || exit 0
grep -q 'private, max-age=604800, immutable' "$target" && exit 0
grep -Fq 'location ~* \.(jpg|jpeg|png|gif|webp|svg|css|js|ico|woff2?)$ {' "$target" || exit 0

backup="$target.before-webp-cache"
temporary="$target.tmp.$$"
cp -n "$target" "$backup" 2>/dev/null || true

awk '
  index($0, "location ~* \\.(jpg|jpeg|png|gif|webp|svg|css|js|ico|woff2?)$ {") {
    print "    # The same JPG/PNG URL can resolve to different bytes based on Accept."
    print "    # Keep it out of shared caches; browsers may still cache their own variant."
    print "    location ~* \\.(jpg|jpeg|png)$ {"
    print "        try_files $uri$webp_suffix $uri =404;"
    print "        add_header Cache-Control \"private, max-age=604800, immutable\" always;"
    print "        add_header Vary \"Accept\" always;"
    print "        access_log off;"
    print "    }"
    print ""
    print "    # Explicit WebP and other static URLs have one representation and are safe"
    print "    # for Cloudflare and other shared caches."
    print "    location ~* \\.(gif|webp|svg|css|js|ico|woff2?)$ {"
    print "        try_files $uri =404;"
    print "        expires 7d;"
    print "        add_header Cache-Control \"public, immutable\";"
    print "        access_log off;"
    print "    }"
    replacing = 1
    next
  }
  replacing && $0 == "    }" { replacing = 0; next }
  !replacing { print }
' "$target" > "$temporary"

mv "$temporary" "$target"
if ! docker exec hosting-nginx nginx -t; then
  cp "$backup" "$target"
  docker exec hosting-nginx nginx -t
  exit 1
fi
docker exec hosting-nginx nginx -s reload

