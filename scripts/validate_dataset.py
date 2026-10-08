#!/usr/bin/env python3
"""Offline integrity checks against the exported questions and actual image bytes."""
import collections
import csv
import hashlib
import json
import re
from pathlib import Path

from bs4 import BeautifulSoup
from PIL import Image
from build_dataset import ROOT, OUT, SLUGS, dump


def read_jsonl(path):
    with path.open(encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def validate():
    errors = []
    def check(ok, message):
        if not ok:
            errors.append(message)
    rows = read_jsonl(OUT / 'questions.jsonl')
    review = read_jsonl(OUT / 'needs_review.jsonl')
    ids = [q['id'] for q in rows]
    main_ids = set(ids)
    check(not main_ids & {q['id'] for q in review}, 'Review and main datasets overlap')
    check(len(rows) >= 3000, 'Fewer than 3,000 usable questions')
    check(len(ids) == len(set(ids)), 'Duplicate question IDs')
    check({'真题', '模拟题'} <= {q['source_type'] for q in rows}, 'Missing requested source types')
    all_paths, referenced_materials = set(), collections.defaultdict(set)
    for q in rows + review:
        prefix = q['id'] + ': '
        check(q['module'] in SLUGS, prefix + 'unknown module')
        check(bool(q['stem']), prefix + 'empty stem')
        check(bool(q['analysis']), prefix + 'empty analysis')
        check(q['answer'] and set(q['answer']) <= q['options'].keys(), prefix + 'invalid answer')
        check(all(v.strip() for v in q['options'].values()), prefix + 'empty option')
        check(q['question_type'] != 'single' or len(q['answer']) == 1, prefix + 'single-choice answer count')
        check(not re.search(r'全力以赴征集|正确答案默认|暂无题目|\*{3,}', q['stem']), prefix + 'placeholder question')
        check(q['has_image'] == bool(q['images']), prefix + 'image flag mismatch')
        check(('has_image' in q['tags']) == q['has_image'], prefix + 'image tag mismatch')
        check(bool(q['occurrences']), prefix + 'missing provenance')
        fields = [(field, q[field + '_html']) for field in ['stem', 'material', 'analysis']]
        fields += [('option_' + k, v) for k, v in q['options_html'].items()]
        html_refs = set()
        for role, value in fields:
            soup = BeautifulSoup(value, 'html.parser')
            check(not soup.find(['script', 'iframe', 'object']), prefix + 'unsafe HTML')
            for img in soup.find_all('img'):
                path = img.get('src', '')
                html_refs.add((path, role))
                check(path.startswith('assets/images/') and not re.search(r'://|^//|data:', path), prefix + 'remote image source')
                check(not img.get('srcset'), prefix + 'unlocalized srcset')
            for node in soup.find_all(True):
                check(not any(k.startswith('on') for k in node.attrs), prefix + 'HTML event handler')
        refs = {(img['path'], img['role']) for img in q['images']}
        check(html_refs == refs, prefix + 'HTML and image index disagree')
        for path, role in refs:
            check((ROOT / path).resolve().is_relative_to((ROOT / 'assets/images').resolve()), prefix + 'image path escapes assets')
            all_paths.add(path)
        if q['material_id'] and q['id'] in main_ids:
            referenced_materials[q['material_id']].add(q['id'])
        if q['module'] == '资料分析' and q['source_type'] == '真题':
            check(bool(q['material']), prefix + 'missing data material')
    for path in sorted(all_paths):
        absolute = ROOT / path
        check(absolute.is_file(), 'Missing image: ' + path)
        if not absolute.is_file():
            continue
        digest = hashlib.sha256(absolute.read_bytes()).hexdigest()
        check(absolute.stem == digest, 'Image hash mismatch: ' + path)
        try:
            with Image.open(absolute) as image:
                image.verify()
        except Exception as error:
            errors.append(f'Invalid image: {path}: {error}')
    for module, slug in SLUGS.items():
        subset = read_jsonl(OUT / 'modules' / f'{slug}.jsonl')
        expected = [q for q in rows if q['module'] == module]
        check(subset == expected, f'Module export mismatch: {module}')
        with (OUT / 'modules' / f'{slug}.csv').open(encoding='utf-8-sig', newline='') as stream:
            csv_rows = list(csv.DictReader(stream))
        check([q['id'] for q in csv_rows] == [q['id'] for q in expected], f'Module CSV mismatch: {module}')
    with (OUT / 'questions.csv').open(encoding='utf-8-sig', newline='') as stream:
        csv_rows = list(csv.DictReader(stream))
    check([q['id'] for q in csv_rows] == ids, 'Master CSV mismatch')
    materials = read_jsonl(OUT / 'materials.jsonl')
    check({m['id']: set(m['question_ids']) for m in materials} == dict(referenced_materials), 'Material groups mismatch')
    material_map = {m['id']: m for m in materials}
    for q in rows:
        if q['material_id']:
            m = material_map[q['material_id']]
            check(m['text'] == q['material'] and m['html'] == q['material_html'], q['id'] + ': material content mismatch')
    manifest = json.loads((ROOT / 'data/raw/downloads.json').read_text())
    for record in manifest:
        path = ROOT / record['path']
        check(path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == record['sha256'], 'Source hash mismatch: ' + record['path'])
    stats = json.loads((OUT / 'stats.json').read_text())
    check(stats['questions'] == len(rows), 'Statistics count mismatch')
    check(stats['modules'] == dict(collections.Counter(q['module'] for q in rows)), 'Statistics module mismatch')
    check(stats['source_types'] == dict(collections.Counter(q['source_type'] for q in rows)), 'Statistics source-type mismatch')
    report = {'passed': not errors, 'questions_checked': len(rows), 'images_checked': len(all_paths),
              'review_questions_checked': len(review),
              'materials_checked': len(materials), 'source_files_checked': len(manifest),
              'errors': errors, 'scope': '字段、去重ID、模块/CSV一致性、材料关联、本地图片及原始文件哈希；不验证每题答案事实正确性。'}
    dump(OUT / 'validation.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == '__main__':
    validate()
