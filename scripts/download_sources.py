#!/usr/bin/env python3
"""Download pinned public question-bank snapshots; never execute upstream code."""
import concurrent.futures
import datetime
import hashlib
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'data' / 'raw'
GONGKAO_REV = '71e9dd7e7bd2689014c7a8af18fdb62556a860c3'


def fetch(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return path.read_bytes()
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'XingceDatasetCollector/1.0'})
            with urllib.request.urlopen(req, timeout=60) as response:
                body = response.read()
            tmp = path.with_suffix(path.suffix + '.part')
            tmp.write_bytes(body)
            tmp.replace(path)
            return body
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)


def main():
    config = json.loads((ROOT / 'sources.json').read_text())
    jobs = []
    base = f'https://raw.githubusercontent.com/mpbfx/gongkao/{GONGKAO_REV}/'
    prefix = 'tools/saduck-scraper/saduck-tiku-json/'
    index = json.loads(fetch(base + prefix + 'papers/index.json', RAW / 'gongkao-index.json'))
    for group in index:
        for paper in group['tkSources']:
            filename = f"papers/{paper['sid']}.json"
            jobs.append((base + prefix + filename, RAW / 'gongkao' / filename))
    jobs += [(base + prefix + 'tags.json', RAW / 'gongkao-tags.json'),
             (base + 'LICENSE', RAW / 'gongkao-LICENSE'),
             (base + 'README.md', RAW / 'gongkao-README.md'),
             (base + prefix + 'papers/index.json', RAW / 'gongkao-index.json')]
    fei_base = f"https://raw.githubusercontent.com/fei98/civil-service-exam-prep/{config['fei']['revision']}/"
    for name in ['Questions', 'Common', 'Data', 'Idioms', 'Logic', 'Speed', 'Verbal']:
        filename = f'seed{name}.ts'
        jobs.append((fei_base + 'src/data/seed/' + filename, RAW / ('fei-' + filename)))
    for name, local in [('LICENSE', 'fei-LICENSE.txt'), ('README.md', 'fei-README.md')]:
        jobs.append((fei_base + name, RAW / local))
    records, failures = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch, url, path): (url, path) for url, path in jobs}
        for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
            url, path = futures[future]
            try:
                body = future.result()
                records.append({'url': url, 'path': str(path.relative_to(ROOT)),
                                'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(),
                                'retrieved_at': datetime.datetime.fromtimestamp(path.stat().st_mtime, datetime.timezone.utc).isoformat()})
            except Exception as error:
                failures.append({'url': url, 'error': str(error)})
            if i % 20 == 0 or i == len(jobs):
                print(f'Sources: {i}/{len(jobs)}, failures: {len(failures)}', flush=True)
    (RAW / 'downloads.json').write_text(json.dumps(sorted(records, key=lambda r: r['path']), ensure_ascii=False, indent=2) + '\n')
    (RAW / 'download_failures.json').write_text(json.dumps(failures, ensure_ascii=False, indent=2) + '\n')
    if failures:
        raise SystemExit(f'{len(failures)} source downloads failed; rerun to resume.')


if __name__ == '__main__':
    main()
