#!/bin/bash
# Custom electron-builder deb postinst (referenced from electron-builder.yml as
# deb.afterInstall). It replaces electron-builder's default template, whose
# chrome-sandbox heuristic does `chmod 0755` (SUID sandbox DISABLED) whenever
# unprivileged user namespaces look available at install time. On Ubuntu 24.04+
# AppArmor blocks unprivileged userns at *runtime*, so Electron falls back to
# the SUID sandbox and aborts ("chrome-sandbox ... must be owned by root and
# have mode 4755"). Always enabling the setuid sandbox works on every kernel.
#
# Paths are hardcoded to match electron-builder.yml: productName "PeerKit Video
# Chat" installs under /opt/PeerKit Video Chat; executableName peerkit-video-chat.

INSTALL_DIR='/opt/PeerKit Video Chat'
EXE='peerkit-video-chat'

if type update-alternatives 2>/dev/null >&1; then
    if [ -L "/usr/bin/$EXE" ] && [ -e "/usr/bin/$EXE" ] && [ "$(readlink "/usr/bin/$EXE")" != "/etc/alternatives/$EXE" ]; then
        rm -f "/usr/bin/$EXE"
    fi
    update-alternatives --install "/usr/bin/$EXE" "$EXE" "$INSTALL_DIR/$EXE" 100 || ln -sf "$INSTALL_DIR/$EXE" "/usr/bin/$EXE"
else
    ln -sf "$INSTALL_DIR/$EXE" "/usr/bin/$EXE"
fi

# Always enable the SUID sandbox (see header).
chmod 4755 "$INSTALL_DIR/chrome-sandbox" || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
