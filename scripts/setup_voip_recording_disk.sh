#!/usr/bin/env bash
set -euo pipefail

DEVICE="${DEVICE:-/dev/sdb}"
PARTITION="${PARTITION:-/dev/sdb1}"
MOUNTPOINT="${MOUNTPOINT:-/recordings}"
LABEL="${LABEL:-ATM_RECORDINGS}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo."
  exit 1
fi

if [[ ! -b "${PARTITION}" ]]; then
  parted -s "${DEVICE}" mklabel gpt mkpart primary ext4 0% 100%
  partprobe "${DEVICE}" || true
  sleep 2
fi

FSTYPE="$(blkid -s TYPE -o value "${PARTITION}" 2>/dev/null || true)"
if [[ "${FSTYPE}" != "ext4" ]]; then
  mkfs.ext4 -F -L "${LABEL}" "${PARTITION}"
fi

mkdir -p "${MOUNTPOINT}"
UUID="$(blkid -s UUID -o value "${PARTITION}")"
grep -v " ${MOUNTPOINT//\//\\/} " /etc/fstab > /tmp/fstab.atm-recorder
cat /tmp/fstab.atm-recorder > /etc/fstab
if ! grep -q "${UUID}" /etc/fstab; then
  echo "UUID=${UUID} ${MOUNTPOINT} ext4 defaults,noatime 0 2" >> /etc/fstab
fi
mount "${MOUNTPOINT}"
df -hT "${MOUNTPOINT}"
