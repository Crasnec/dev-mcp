#!/bin/sh
# Invoked only by the trusted provisioner, never exposed to runner containers.
set -eu
operation="${1:-}"
if [ "$operation" = prepare ]; then
  exec 9>/images/pool.lock
  flock -x 9
  if [ ! -f /images/pool.xfs ]; then
    truncate -s 100G /images/pool.xfs.new
    mkfs.xfs -q /images/pool.xfs.new
    mv /images/pool.xfs.new /images/pool.xfs
  fi
  [ "$(blkid -p -s TYPE -o value /images/pool.xfs)" = xfs ]
  if [ ! -f /images/device ]; then
    number=2048
    while [ "$number" -lt 4096 ]; do
      device="/dev/loop$number"
      if [ ! -e "$device" ]; then
        mknod -m 600 "$device" b 7 "$number"
        printf '%s\n' "$device" > /images/device
        break
      fi
      number=$((number + 1))
    done
  fi
  device="$(cat /images/device)"
  case "$device" in /dev/loop[0-9]*) ;; *) exit 1;; esac
  number="${device#/dev/loop}"
  case "$number" in *[!0-9]*|'') exit 1;; esac
  [ "$number" -ge 2048 ] && [ "$number" -lt 4096 ]
  if [ ! -e "$device" ]; then
    mknod -m 600 "$device" b 7 "$number"
  fi
  attached="$(losetup -j /images/pool.xfs -n -O NAME)"
  if [ "$attached" != "$device" ]; then
    # Never rebind a device occupied by unrelated host storage.
    [ -z "$attached" ]
    if losetup "$device" >/dev/null 2>&1; then
      echo 'Reserved loop device is occupied' >&2
      exit 1
    fi
    losetup "$device" /images/pool.xfs
  fi
  printf '%s\n' "$device"
  exit 0
fi

id="${2:-}"
limit="${3:-}"
project="${4:-}"
case "$id" in *[!0-9a-f-]*|'') exit 2;; esac
[ "${#id}" = 36 ]
case "$limit:$project" in *[!0-9:]*|:*) exit 2;; esac
[ "$project" -ge 1000 ] && [ "$project" -le 2147483647 ]
[ "$limit" -le 102400 ]
mkdir -p /pool/.locks
exec 8>"/pool/.locks/$id"
flock -x 8
root="/pool/$id"
[ ! -L "$root" ]
mkdir -p "$root/workspace" "$root/data"
[ ! -L "$root/workspace" ] && [ ! -L "$root/data" ]
case "$operation" in
  limit|migrate)
    # The target user is stopped while assigning a project or copying data.
    # XFS enforces the shared workspace+runtime hard limit for every syscall.
    xfs_quota -x -c "project -s -p $root $project" /pool >/dev/null
    usage="$(du -sx -B1 "$root" | cut -f1)"
    if [ "$limit" -gt 0 ] && [ "$usage" -gt "$((limit * 1048576))" ]; then
      echo 'Quota is below current usage' >&2
      exit 1
    fi
    xfs_quota -x -c "limit -p bsoft=0 bhard=${limit}m $project" /pool
    hard="$(xfs_quota -x -c "quota -p -b -N $project" /pool | awk 'NF >= 4 {print $4; exit}')"
    [ "$hard" = "$((limit * 1024))" ]
    if [ "$operation" = migrate ]; then
      rsync -aHAX --numeric-ids /source-workspace/ "$root/workspace/"
      rsync -aHAX --numeric-ids /source-data/ "$root/data/"
    fi
    ;;
  usage)
    xfs_quota -x -c "quota -p -b -N $project" /pool | awk 'NF >= 4 {print $2, $4; exit}'
    ;;
  *) exit 2;;
esac
