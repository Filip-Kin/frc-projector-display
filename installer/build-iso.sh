#!/bin/bash
# build-iso.sh — builds a preseeded Debian 13 (Trixie) installer ISO for FRC display thin clients.
#
# Output: ./frc-display-installer.iso (override with OUT=... env var)
# Requires: xorriso, isolinux (for isohdpfx.bin), curl
#   sudo apt install xorriso isolinux
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-/tmp/frc-iso-build}"
OUT="${OUT:-$SCRIPT_DIR/frc-display-installer.iso}"

for cmd in xorriso curl awk; do
  command -v "$cmd" >/dev/null || { echo "Missing: $cmd"; echo "  sudo apt install xorriso isolinux"; exit 1; }
done

ISOHDPFX=/usr/lib/ISOLINUX/isohdpfx.bin
[ -f "$ISOHDPFX" ] || ISOHDPFX=/usr/lib/syslinux/mbr/isohdpfx.bin
[ -f "$ISOHDPFX" ] || { echo "Missing isohdpfx.bin (sudo apt install isolinux)"; exit 1; }

mkdir -p "$WORK"
cd "$WORK"

echo "[1/5] Locating current Debian 13 netinst ISO..."
SHA_URL="https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/SHA256SUMS"
ISO_NAME=$(curl -fsSL "$SHA_URL" | awk '/-amd64-netinst\.iso$/ {gsub(/^\*/,"",$2); print $2; exit}')
[ -n "$ISO_NAME" ] || { echo "Could not parse netinst ISO name from $SHA_URL"; exit 1; }
echo "  -> $ISO_NAME"

if [ ! -f "$ISO_NAME" ]; then
  echo "[2/5] Downloading $ISO_NAME (~600MB)..."
  curl -fL --progress-bar -o "$ISO_NAME.part" \
    "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/$ISO_NAME"
  mv "$ISO_NAME.part" "$ISO_NAME"
else
  echo "[2/5] Using cached $ISO_NAME"
fi

echo "[3/5] Extracting ISO contents..."
rm -rf iso/
xorriso -osirrox on -indev "$ISO_NAME" -extract / iso/ 2>&1 | tail -2
chmod -R u+w iso/

echo "[4/5] Injecting preseed + firstboot files and patching boot configs..."
cp "$SCRIPT_DIR/preseed.cfg"       iso/preseed.cfg
cp "$SCRIPT_DIR/firstboot.sh"      iso/firstboot.sh
cp "$SCRIPT_DIR/firstboot.service" iso/firstboot.service

# UEFI boot menu (GRUB)
if [ -f iso/boot/grub/grub.cfg ]; then
  cat > iso/boot/grub/grub.cfg << 'GRUBEOF'
set default=0
set timeout=5

menuentry "FRC Display Auto Install" {
    linux /install.amd/vmlinuz auto=true priority=high preseed/file=/cdrom/preseed.cfg ---
    initrd /install.amd/initrd.gz
}
menuentry "Manual install (rescue)" {
    linux /install.amd/vmlinuz ---
    initrd /install.amd/initrd.gz
}
GRUBEOF
fi

# BIOS boot menu (isolinux)
if [ -f iso/isolinux/isolinux.cfg ]; then
  cat > iso/isolinux/isolinux.cfg << 'ISOEOF'
default frc
timeout 50
prompt 0

label frc
  menu label FRC Display Auto Install
  kernel /install.amd/vmlinuz
  append auto=true priority=high preseed/file=/cdrom/preseed.cfg initrd=/install.amd/initrd.gz ---

label rescue
  menu label Manual install (rescue)
  kernel /install.amd/vmlinuz
  append initrd=/install.amd/initrd.gz ---
ISOEOF
fi

# Recompute md5sum.txt so the installer's integrity check passes.
# No -follow: ISO root has a `debian -> .` symlink that would loop forever.
( cd iso && find . -type f ! -name md5sum.txt -print0 \
    | xargs -0 md5sum > md5sum.txt )

echo "[5/5] Repacking ISO -> $OUT"
xorriso -as mkisofs \
  -r -V "FRC-DISPLAY-INSTALL" \
  -J -joliet-long \
  -isohybrid-mbr "$ISOHDPFX" \
  -partition_offset 16 \
  -b isolinux/isolinux.bin -c isolinux/boot.cat \
    -no-emul-boot -boot-load-size 4 -boot-info-table \
  -eltorito-alt-boot \
    -e boot/grub/efi.img -no-emul-boot \
    -isohybrid-gpt-basdat \
  -o "$OUT" \
  iso/ 2>&1 | tail -5

echo ""
echo "=== Done ==="
echo "ISO:  $OUT  ($(du -h "$OUT" | cut -f1))"
echo ""
echo "Flash to USB (replace /dev/sdX, verify with lsblk first):"
echo "  sudo dd if=$OUT of=/dev/sdX bs=4M status=progress oflag=sync"
