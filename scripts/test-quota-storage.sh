#!/bin/sh
# Run in a disposable privileged test container, with no host mounts or Docker
# socket. Only its temporary image and loop association are created and removed.
set -eu
helper=/opt/dev-mcp/scripts/quota-storage.sh
mkdir -p /images /pool /source-workspace /source-data
cleanup() {
  umount /pool 2>/dev/null || true
  if [ -f /images/device ]; then
    losetup -d "$(cat /images/device)"
  fi
}
trap cleanup EXIT
sh "$helper" prepare
loop="$(cat /images/device)"
mount -t xfs -o prjquota "$loop" /pool
printf 'preserved project\n' > /source-workspace/project.txt
printf 'preserved state\n' > /source-data/state.txt
chown -R 1000:1000 /source-workspace /source-data
id=00000000-0000-4000-8000-000000000001
sh "$helper" migrate "$id" 64 1000
cmp /source-workspace/project.txt "/pool/$id/workspace/project.txt"
cmp /source-data/state.txt "/pool/$id/data/state.txt"
setpriv --reuid=1000 --regid=1000 --clear-groups node -e '
  const fs=require("node:fs");
  const root=process.argv[1];
  fs.writeFileSync(root+"/workspace/first.bin", Buffer.alloc(40*1048576));
  try { fs.writeFileSync(root+"/data/second.bin", Buffer.alloc(40*1048576)); throw Error("Quota was not enforced"); }
  catch(error) { if(!["EDQUOT","ENOSPC"].includes(error.code)) throw error; }
  console.log("PASS combined workspace/data hard quota blocks writes at the filesystem");
' "/pool/$id"
sh "$helper" usage "$id" 0 1000
sh "$helper" limit "$id" 128 1000
setpriv --reuid=1000 --regid=1000 --clear-groups node -e 'require("node:fs").writeFileSync(process.argv[1],Buffer.alloc(40*1048576))' "/pool/$id/data/second.bin"
if sh "$helper" limit "$id" 64 1000; then
  echo 'Shrinking below usage must fail' >&2
  exit 1
fi
sh "$helper" limit "$id" 0 1000
printf 'PASS migration, quota increase, rejection below usage, unlimited reset\n'
