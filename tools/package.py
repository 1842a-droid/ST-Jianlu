"""Create a direct-install extension ZIP and a source ZIP with only stdlib."""
from pathlib import Path
import hashlib
import json
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT.parent
VERSION = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['version']
RUNTIME = ['manifest.json', 'index.js', 'app.js', 'host.js', 'store.js', 'chunker.js', 'queue.js', 'ui.js', 'stream.js', 'library.js', 'library-ui.js', 'tavern.js', 'style.css', 'README.md', 'TESTING.md', 'CHANGELOG.md', 'LICENSE']
OUT.mkdir(parents=True, exist_ok=True)

for name in RUNTIME:
    if not (ROOT / name).is_file():
        raise RuntimeError(f'Missing runtime file: {name}')
    if name.endswith('.js'):
        for dependency in re.findall(r"from\s+['\"](\./[^'\"]+)['\"]", (ROOT / name).read_text(encoding='utf-8')):
            if dependency[2:] not in RUNTIME:
                raise RuntimeError(f'Missing runtime dependency: {dependency}')

packages = [
    (OUT / f'笺录-酒馆扩展-{VERSION}.zip', [ROOT / name for name in RUNTIME]),
    (OUT / f'笺录-酒馆扩展-{VERSION}-源码.zip', [p for p in ROOT.rglob('*') if p.is_file() and not set(p.relative_to(ROOT).parts).intersection({'.git', 'node_modules', '__pycache__', 'outputs'})]),
]
for target, files in packages:
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for source in sorted(files):
            archive.write(source, 'ST-Jianlu/' + source.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('ZIP integrity check failed')
        manifest = json.loads(archive.read('ST-Jianlu/manifest.json'))
        assert manifest['version'] == VERSION
        assert all('ST-Jianlu/' + name in archive.namelist() for name in RUNTIME)
    digest = hashlib.sha256(target.read_bytes()).hexdigest().upper()
    target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n', encoding='utf-8')
    print(json.dumps({'file': str(target), 'bytes': target.stat().st_size, 'sha256': digest, 'files': len(files)}, ensure_ascii=False))
