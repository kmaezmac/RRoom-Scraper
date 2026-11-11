#!/usr/bin/env python3
"""Use Ubuntu's primary archive on the disposable Ubuntu 24.04 x64 runner."""
from pathlib import Path
import platform
import re

ARCHIVE = 'https://archive.ubuntu.com/ubuntu/'
SECURITY = 'https://security.ubuntu.com/ubuntu/'
REPLACEMENTS = {
    'mirror+file:/etc/apt/apt-mirrors.txt': ARCHIVE,
    'mirror+file:/etc/apt/apt-security-mirrors.txt': SECURITY,
    'http://azure.archive.ubuntu.com/ubuntu': ARCHIVE,
    'https://azure.archive.ubuntu.com/ubuntu': ARCHIVE,
}

def rewrite(text):
    # Match whole URI tokens only. Preserve suites, components, Signed-By and
    # every third-party source; never disable APT signature verification.
    for source, target in REPLACEMENTS.items():
        text = re.sub(r'(?<!\S)' + re.escape(source) + r'/?(?=\s|$)', target, text)
    return text

def configure(root=Path('/')):
    os_release = (root / 'etc/os-release').read_text()
    if not re.search(r'^ID="?ubuntu"?$', os_release, re.M) or not re.search(r'^VERSION_ID="?24\.04"?$', os_release, re.M):
        raise RuntimeError('This setup requires Ubuntu 24.04')
    if platform.machine() != 'x86_64':
        raise RuntimeError('This setup requires an x64 runner')
    apt = root / 'etc/apt'
    files = [apt / 'sources.list', *sorted((apt / 'sources.list.d').glob('*.list')), *sorted((apt / 'sources.list.d').glob('*.sources'))]
    changed = 0
    official = False
    for path in files:
        if not path.is_file():
            continue
        original = path.read_text()
        updated = rewrite(original)
        official |= ARCHIVE in updated or SECURITY in updated
        if original != updated:
            path.write_text(updated)
            changed += 1
    if not official:
        raise RuntimeError('No supported Ubuntu archive source found')
    print(f'Ubuntu official archive configured ({changed} source files updated)')

if __name__ == '__main__':
    configure()
