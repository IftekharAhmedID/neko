#!/usr/bin/env python3
"""
Pack a Chromium extension directory into a signed .crx file (CRX2 format).

This mirrors Firefox's .xpi approach: the extension is packed at Docker build time
and installed via Chromium enterprise policies (ExtensionInstallForcelist).

Usage:
    python3 pack-crx.py /opt/translucid/extension /opt/translucid/extension.crx

Outputs:
    - extension.crx      — Signed CRX2 package
    - extension.id        — 32-char extension ID (derived from signing key)
    - extension-updates.xml — Update manifest for ExtensionInstallForcelist policy
"""

import hashlib
import os
import struct
import subprocess
import sys
import tempfile

def main():
    if len(sys.argv) < 3:
        print("Usage: pack-crx.py <extension_dir> <output.crx> [key.pem]")
        sys.exit(1)

    ext_dir = sys.argv[1]
    out_crx = sys.argv[2]
    key_file = sys.argv[3] if len(sys.argv) > 3 else '/tmp/translucid-extension.pem'

    # 1. Generate RSA signing key if it doesn't exist
    if not os.path.exists(key_file):
        subprocess.run(
            ['openssl', 'genrsa', '-out', key_file, '2048'],
            capture_output=True, check=True
        )
        print(f"[pack-crx] Generated signing key: {key_file}")

    # 2. Create a zip of the extension directory
    zip_path = tempfile.mktemp(suffix='.zip')
    subprocess.run(
        ['zip', '-qr', zip_path, '.'],
        cwd=ext_dir, check=True
    )
    with open(zip_path, 'rb') as f:
        zip_data = f.read()
    print(f"[pack-crx] Extension zipped: {len(zip_data)} bytes")

    # 3. Get DER-encoded public key
    pub_der = subprocess.run(
        ['openssl', 'rsa', '-in', key_file, '-pubout', '-outform', 'DER'],
        capture_output=True, check=True
    ).stdout

    # 4. Sign the zip with the private key (SHA1 signature)
    sig = subprocess.run(
        ['openssl', 'dgst', '-sha1', '-sign', key_file, zip_path],
        capture_output=True, check=True
    ).stdout

    # 5. Compute extension ID
    #    First 16 bytes of SHA256(public_key_der), mapped 0-f → a-p
    key_hash = hashlib.sha256(pub_der).hexdigest()[:32]
    ext_id = ''.join(chr(ord('a') + int(c, 16)) for c in key_hash)
    print(f"[pack-crx] Extension ID: {ext_id}")

    # 6. Write CRX2 file
    #    Format: magic(4) + version(4) + pubkey_len(4) + sig_len(4) + pubkey + sig + zip
    with open(out_crx, 'wb') as f:
        f.write(b'Cr24')                                # Magic number
        f.write(struct.pack('<I', 2))                    # CRX version 2
        f.write(struct.pack('<I', len(pub_der)))         # Public key length
        f.write(struct.pack('<I', len(sig)))             # Signature length
        f.write(pub_der)                                 # Public key (DER)
        f.write(sig)                                     # Signature
        f.write(zip_data)                                # Extension zip
    print(f"[pack-crx] CRX written: {out_crx} ({os.path.getsize(out_crx)} bytes)")

    # 7. Write extension ID to file (used by Dockerfile to embed in policy)
    id_file = out_crx.replace('.crx', '.id')
    with open(id_file, 'w') as f:
        f.write(ext_id)

    # 8. Write update manifest XML (required by ExtensionInstallForcelist)
    xml_file = out_crx.replace('.crx', '-updates.xml')
    with open(xml_file, 'w') as f:
        f.write(f'<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write(f'<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">\n')
        f.write(f'  <app appid="{ext_id}">\n')
        f.write(f'    <updatecheck codebase="file:///opt/translucid/extension.crx" version="1.0.0"/>\n')
        f.write(f'  </app>\n')
        f.write(f'</gupdate>\n')
    print(f"[pack-crx] Update manifest: {xml_file}")

    # Cleanup
    os.unlink(zip_path)
    print(f"[pack-crx] Done. Install via policy: ExtensionInstallForcelist = [\"{ext_id};file:///opt/translucid/extension-updates.xml\"]")

if __name__ == '__main__':
    main()
