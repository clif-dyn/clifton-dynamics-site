#!/bin/sh
set -eu
# Run with sudo from the uploaded, tested release folder. No firewall or DNS changes.
[ "$(id -u)" = 0 ] || { echo 'Run this installer with sudo.' >&2; exit 1; }
[ -f server.mjs ] && [ -d node_modules ] || { echo 'Tested server and installed dependencies required.' >&2; exit 1; }
/usr/bin/node -e 'require("node:sqlite")' >/dev/null
if ! getent passwd clifton-contact >/dev/null; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin clifton-contact
fi
install -d -m 0755 /opt/clifton-contact
install -d -m 0700 /etc/clifton-contact
cp -R server.mjs package.json package-lock.json node_modules /opt/clifton-contact/
chown -R root:root /opt/clifton-contact
chmod -R u=rwX,go=rX /opt/clifton-contact
if [ ! -f /etc/clifton-contact/credentials.env ]; then
  /usr/bin/python3 - <<'PY'
from pathlib import Path
import secrets, os
p=Path('/etc/clifton-contact/credentials.env')
fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f:
    f.write('CHALLENGE_SECRET='+secrets.token_hex(32)+'\n')
    f.write('ALLOWED_ORIGINS=https://cliftondynamics.com,https://www.cliftondynamics.com\n')
    f.write('TRUST_LOCAL_PROXY=false\n')
PY
fi
install -m 0755 deploy/configure-mail.py /opt/clifton-contact/configure-mail
install -m 0644 deploy/clifton-contact.service /etc/systemd/system/clifton-contact.service
systemctl daemon-reload
systemctl enable clifton-contact
systemctl restart clifton-contact
systemctl is-active clifton-contact
