#!/usr/bin/env python3
"""Download referenced images, validate them, and name them by content hash."""
import concurrent.futures
import hashlib
import io
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from bs4 import BeautifulSoup
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'data' / 'raw'
INDEX = RAW / 'image_downloads.json'


def canonical_url(value):
    value = value.strip()
    if value.startswith('//'):
        value = 'https:' + value
    parts = urllib.parse.urlsplit(value)
    if parts.scheme not in ('http', 'https'):
        raise ValueError(f'Unsupported image source: {value[:100]}')
    # Tarzan's width parameter is a thumbnail hint. Keep the full source image.
    if '/tarzan/images/' in parts.path:
        query = urllib.parse.urlencode([(k, v) for k, v in urllib.parse.parse_qsl(parts.query)
                                        if k != 'width'])
        value = urllib.parse.urlunsplit(('https', parts.netloc, parts.path, query, ''))
    return value


def image_sources(html):
    soup = BeautifulSoup(html or '', 'html.parser')
    return [canonical_url(img.get('src') or img.get('data-src') or '') for img in soup.find_all('img')]


def download(url, cached):
    old = cached.get(url)
    if old and old.get('status') == 'ok' and (ROOT / old['path']).is_file():
        return old
    for attempt in range(3):
        try:
            # This public alias serves the same resources without the binary
            # envelope returned by some fenbike endpoints.
            parts = urllib.parse.urlsplit(url)
            fetch_url = urllib.parse.urlunsplit(parts._replace(netloc='fb.fbstatic.cn')) if parts.netloc == 'fb.fenbike.cn' else url
            request = urllib.request.Request(fetch_url, headers={'User-Agent': 'XingceDatasetCollector/1.0'})
            with urllib.request.urlopen(request, timeout=25) as response:
                body = response.read(15 * 1024 * 1024 + 1)
            if len(body) > 15 * 1024 * 1024:
                raise ValueError('Image exceeds 15 MiB')
            with Image.open(io.BytesIO(body)) as picture:
                fmt = picture.format
                width, height = picture.size
                picture.verify()
            extensions = {'PNG': '.png', 'JPEG': '.jpg', 'GIF': '.gif', 'WEBP': '.webp', 'BMP': '.bmp'}
            if fmt not in extensions:
                raise ValueError(f'Unsupported image format: {fmt}')
            digest = hashlib.sha256(body).hexdigest()
            relative = f'assets/images/{digest[:2]}/{digest}{extensions[fmt]}'
            path = ROOT / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            # Multiple URLs can resolve to the same image. Atomic temporary files
            # are unique per URL, and replacement is safe for identical content.
            tmp = path.with_suffix('.' + hashlib.sha256(url.encode()).hexdigest()[:12] + '.part')
            tmp.write_bytes(body)
            tmp.replace(path)
            return {'status': 'ok', 'path': relative, 'sha256': digest, 'bytes': len(body),
                    'width': width, 'height': height, 'format': fmt, 'download_url': fetch_url}
        except Exception as error:
            if attempt == 2:
                return {'status': 'failed', 'error': f'{type(error).__name__}: {error}'}
            time.sleep(attempt + 1)


def main():
    urls = set()
    for path in sorted((RAW / 'gongkao' / 'papers').glob('*.json')):
        for question in json.loads(path.read_text())['questions']:
            fields = [question.get(k, '') for k in ('titleHtml', 'materialHtml', 'analysisHtml')]
            fields.extend(option.get('text', '') for option in question.get('options', []))
            for html in fields:
                urls.update(image_sources(html))
    cache = json.loads(INDEX.read_text()) if INDEX.exists() else {}
    print(f'Image URLs: {len(urls)}, cached: {sum(v.get("status") == "ok" for v in cache.values())}', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(download, url, cache): url for url in sorted(urls)}
        for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
            cache[futures[future]] = future.result()
            if i % 100 == 0 or i == len(futures):
                INDEX.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + '\n')
                failed = sum(x.get('status') == 'failed' for x in cache.values())
                print(f'Images: {i}/{len(futures)}, failed: {failed}', flush=True)
    print('Unique local images:', len({x['path'] for x in cache.values() if x['status'] == 'ok'}), flush=True)


if __name__ == '__main__':
    main()
