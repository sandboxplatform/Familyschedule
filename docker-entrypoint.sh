#!/bin/sh
# Hands a mounted volume to the user the app runs as, then becomes that user.
#
# Hosts attach volumes owned by root. A container that has already dropped to an
# unprivileged user cannot chown them, so it finds the volume unwritable, falls
# back to its own filesystem, and loses the lot on the next deploy — quietly,
# because everything works until then.
#
# So: start as root, fix whichever mounts are actually there, and drop. If we
# are already unprivileged (a host that overrides the user), nothing here is
# possible and the app's own check reports it instead.
set -e

if [ "$(id -u)" = '0' ]; then
  # Resolved once, and only trusted if it resolved: comparing against an empty
  # string would chown every directory on every boot and report nothing.
  node_uid="$(id -u node 2>/dev/null || true)"

  if [ -n "$node_uid" ]; then
    for dir in /data /var/hearth /app/data; do
      [ -d "$dir" ] || continue
      # Only when it is not already ours: chown -R across a large volume on
      # every boot is a slow way to start a calendar.
      if [ "$(stat -c '%u' "$dir" 2>/dev/null)" != "$node_uid" ]; then
        chown -R node:node "$dir" 2>/dev/null || true
      fi
    done
    exec su-exec node "$@"
  fi
fi

exec "$@"
