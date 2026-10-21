#!/usr/bin/python3
"""Run interactively with sudo on the server. No credentials are echoed or logged."""
import getpass, json, os, re, subprocess, tempfile
from pathlib import Path
if os.geteuid() != 0:
    raise SystemExit('Run with sudo on the server.')
path = Path('/etc/clifton-contact/credentials.env')
print('Configure Proton delivery. Use a dedicated SMTP token, not your Proton password.')
user = input('Proton SMTP email address: ').strip()
recipient = input('Inbox for enquiries (Enter for the same address): ').strip() or user
token = getpass.getpass('Proton SMTP token (hidden): ').strip()
email = r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
if not re.fullmatch(email, user) or not re.fullmatch(email, recipient):
    raise SystemExit('Invalid email address; nothing changed.')
if not token or any(ord(c) < 32 or ord(c) > 126 for c in token):
    raise SystemExit('Invalid token; nothing changed.')
values = {'PROTON_SMTP_USER': user, 'CONTACT_RECIPIENT': recipient, 'PROTON_SMTP_TOKEN': token}
lines = [line for line in path.read_text().splitlines() if line.split('=',1)[0] not in values]
# Escape only characters that systemd EnvironmentFile treats specially in double quotes.
def quote(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$') + '"'
lines += [key + '=' + quote(value) for key, value in values.items()]
fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.credentials-')
with os.fdopen(fd, 'w') as out:
    os.fchmod(out.fileno(), 0o600)
    out.write('\n'.join(lines) + '\n')
os.replace(temporary, path)
subprocess.run(['systemctl','restart','clifton-contact'], check=True)
print('Private mail settings saved and service restarted. No email has been sent yet.')
