#!/usr/bin/env python3
"""Normalize source snapshots into a deduplicated, local-image question bank."""
import ast
import collections
import csv
import hashlib
import html
import json
import re
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString
from download_images import canonical_url

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'data' / 'raw'
OUT = ROOT / 'data' / 'xingce'
CONFIG = json.loads((ROOT / 'sources.json').read_text())
MODULES = ['政治理论', '常识判断', '言语理解', '数量关系', '判断推理', '资料分析']
SLUGS = dict(zip(MODULES, ['politics', 'general_knowledge', 'verbal', 'quantitative', 'reasoning', 'data_analysis']))


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as stream:
        for row in rows:
            line = json.dumps(row, ensure_ascii=False, separators=(',', ':'))
            # Keep exactly one physical/logical line even for splitlines-based readers.
            for char in ('\u2028', '\u2029', '\u0085'):
                line = line.replace(char, f'\\u{ord(char):04x}')
            stream.write(line + '\n')


def fingerprint(value):
    return hashlib.sha256(value.encode()).hexdigest()


def parse_static_ts(text):
    """Read the literal JSON5-like array; reject expressions instead of executing TS."""
    match = re.search(r'export const \w+: Question\[\]\s*=\s*(\[.*\]);?\s*$', text, re.S)
    if not match:
        raise ValueError('Expected a static Question[] literal')
    source = match.group(1)
    token = re.compile(r'\s+|//[^\n]*|/\*.*?\*/|\'(?:\\.|[^\'\\])*\'|"(?:\\.|[^"\\])*"|[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?|[{}\[\]:,]', re.S)
    tokens, pos = [], 0
    while pos < len(source):
        m = token.match(source, pos)
        if not m:
            raise ValueError(f'Non-literal TypeScript at offset {pos}')
        value = m.group()
        pos = m.end()
        if value.isspace() or value.startswith(('//', '/*')):
            continue
        if value[0] in '\'"':
            value = json.dumps(ast.literal_eval(value), ensure_ascii=False)
        elif re.fullmatch(r'[A-Za-z_$][\w$]*', value) and value not in ('true', 'false', 'null'):
            value = json.dumps(value)
        tokens.append(value)
    # Remove only structural trailing commas, not comma characters inside strings.
    tokens = [v for i, v in enumerate(tokens) if not (v == ',' and i + 1 < len(tokens) and tokens[i + 1] in (']', '}'))]
    return json.loads(''.join(tokens))


def math_text(node):
    if isinstance(node, NavigableString):
        return str(node)
    children = [math_text(child) for child in node.children if not isinstance(child, NavigableString) or str(child).strip()]
    if node.name == 'mfrac' and len(children) == 2:
        return f'({children[0]})/({children[1]})'
    if node.name == 'msup' and len(children) == 2:
        return f'({children[0]})^({children[1]})'
    if node.name == 'msub' and len(children) == 2:
        return f'{children[0]}_({children[1]})'
    if node.name == 'msubsup' and len(children) == 3:
        return f'{children[0]}_({children[1]})^({children[2]})'
    if node.name == 'msqrt':
        return '√(' + ''.join(children) + ')'
    if node.name == 'mroot' and len(children) == 2:
        return f'root({children[0]},{children[1]})'
    return ''.join(children)


def plain_text(html_value):
    soup = BeautifulSoup(html_value, 'html.parser')
    for math in soup.find_all('math'):
        math.replace_with(math_text(math))
    for image in soup.find_all('img'):
        image.replace_with(f"![{image.get('alt', '图片')}]({image['src']})")
    for line_break in soup.find_all('br'):
        line_break.replace_with('\n')
    for node in soup.find_all(['p', 'div', 'tr']):
        node.append('\n')
    for node in soup.find_all(['td', 'th']):
        node.append('\t')
    return re.sub(r'\n{3,}', '\n\n', soup.get_text()).strip()


def canonical_content(value):
    soup = BeautifulSoup(value or '', 'html.parser')
    for image in soup.find_all('img'):
        image.replace_with('[image:' + canonical_url(image.get('src') or image.get('data-src') or '') + ']')
    for math in soup.find_all('math'):
        math.replace_with(math_text(math))
    return re.sub(r'\s+', '', soup.get_text())


def normalize_html(value, role, assets):
    soup = BeautifulSoup(value or '', 'html.parser')
    images, issues = [], []
    for bad in soup.find_all(['script', 'style', 'iframe', 'object', 'embed', 'link']):
        bad.decompose()
    for node in soup.find_all(True):
        original = dict(node.attrs)
        node.attrs = {k: v for k, v in original.items()
                      if k in {'alt', 'width', 'height', 'colspan', 'rowspan', 'display', 'xmlns', 'mathvariant'}}
        if node.name != 'img':
            continue
        url = canonical_url(original.get('src') or original.get('data-src') or '')
        asset = assets.get(url, {})
        if asset.get('status') != 'ok':
            issues.append('image_download_failed')
            node.replace_with('[图片下载失败]')
            continue
        node['src'] = asset['path']
        kind = 'formula' if original.get('flag') == 'tex' or '/formulas?' in url else 'image'
        images.append({'path': asset['path'], 'role': role, 'kind': kind,
                       'width': asset['width'], 'height': asset['height']})
    normalized = str(soup)
    return normalized, plain_text(normalized), images, issues


def taxonomy():
    result = {}
    def visit(node, path):
        chain = path + [node['id']]
        result[node['id']] = chain
        for child in node.get('children', []):
            visit(child, chain)
    for node in json.loads((RAW / 'gongkao-tags.json').read_text()):
        visit(node, [])
    for name, module in {'图像推理': '判断推理', '病语': '言语理解', '逻辑题空': '言语理解',
                         '歧义句': '言语理解', '论证缺陷': '判断推理', '新思想': '政治理论',
                         '历史': '常识判断', '公文': '常识判断', '管理': '常识判断'}.items():
        result.setdefault(name, [module, name])
    return result


def paper_records():
    tag_map = taxonomy()
    index = json.loads((RAW / 'gongkao-index.json').read_text())
    for group in index:
        for entry in group['tkSources']:
            path = RAW / 'gongkao' / 'papers' / f"{entry['sid']}.json"
            paper = json.loads(path.read_text())
            ranges = json.loads(paper['model'])
            year_match = re.search(r'(?:19|20)\d{2}', paper['source'])
            year = int(year_match.group()) if year_match else None
            for number, q in enumerate(paper['questions'], 1):
                source_module = next((r['name'] for r in ranges if r['snum'] <= number <= r['enum']), None)
                aliases = {'言语理解与表达': '言语理解', '数理能力': '数量关系', '数理': '数量关系',
                           '数学运算': '数量关系', '科学素养': '常识判断', '综合知识': '常识判断',
                           '综合分析': '常识判断'}
                module = aliases.get(source_module, source_module)
                tag_path = tag_map.get(q.get('tag', ''), [])
                flags = []
                if tag_path:
                    if module not in MODULES:
                        flags.append('module_from_tag_fallback')
                    elif module != tag_path[0] and not (module == '常识判断' and tag_path[0] == '政治理论'):
                        flags.append('module_corrected_from_source_tag')
                    module = tag_path[0]
                options = {o['label']: o.get('text', '') for o in q['options']}
                value_to_label = {str(o['value']): o['label'] for o in q['options']}
                answers = [value_to_label.get(a.strip(), a.strip()) for a in str(q['correctAnswer']).split(',')]
                source_path = 'tools/saduck-scraper/saduck-tiku-json/papers/' + path.name
                occurrence = {'dataset': 'gongkao', 'source_id': str(q['id']), 'paper_id': str(paper['sid']),
                              'paper_title': paper['source'].strip(), 'question_number': number,
                              'year': year, 'province': group['title'], 'source_tag': q.get('tag', ''),
                              'source_module': source_module,
                              'source_url': f"{CONFIG['gongkao']['repository']}/blob/{CONFIG['gongkao']['revision']}/{source_path}",
                              'raw_path': str(path.relative_to(ROOT))}
                yield {'module': module, 'submodule': tag_path[1] if len(tag_path) > 1 else q.get('tag') or source_module or '未细分',
                       'classification_basis': 'source_tag' if tag_path else 'paper_section',
                       'knowledge_points': tag_path[1:] or ([q['tag']] if q.get('tag') else []),
                       'source_type': '真题', 'question_type': q['type'],
                       'stem_html': q['titleHtml'], 'material_html': q['materialHtml'],
                       'analysis_html': q['analysisHtml'], 'options_html': options,
                       'answer': sorted(answers), 'difficulty': None, 'accuracy': q['globalAccuracy'],
                       'source_reviewed': None, 'quality_flags': flags, 'occurrences': [occurrence]}


def mock_records():
    for path in sorted(RAW.glob('fei-seed*.ts')):
        for q in parse_static_ts(path.read_text()):
            if q['sourceType'] != '自建':
                continue
            escape = lambda value: html.escape(value).replace('\n', '<br>')
            tags = q.get('pitfallTags', [])
            charts = [q['chart']] if q.get('chart') else []
            # Charts remain structured table/series data as in the source.
            material_html = ''
            for chart in charts:
                columns = chart.get('columns', ['项目', '数值'])
                chart_rows = chart.get('rows', [[x['label'], x['value']] for x in chart.get('data', [])])
                material_html += '<p>' + html.escape(chart.get('title', '')) + '</p><table><thead><tr>'
                material_html += ''.join('<th>' + html.escape(str(x)) + '</th>' for x in columns) + '</tr></thead><tbody>'
                material_html += ''.join('<tr>' + ''.join('<td>' + html.escape(str(x)) + '</td>' for x in row) + '</tr>' for row in chart_rows)
                material_html += '</tbody></table>'
            yield {'module': q['category'], 'submodule': tags[0] if tags else '专项练习',
                   'classification_basis': 'source_category',
                   'knowledge_points': tags, 'source_type': '模拟题', 'question_type': q['type'],
                   'stem_html': escape(q['stem']), 'material_html': material_html, 'analysis_html': escape(q['explanation']),
                   'options_html': {k: escape(v) for k, v in q['options'].items()}, 'answer': [q['answer']],
                   'difficulty': q.get('difficulty'), 'accuracy': None, 'source_reviewed': q.get('reviewed'),
                   'charts': charts, 'quality_flags': [],
                   'occurrences': [{'dataset': 'fei', 'source_id': q['id'], 'paper_id': None,
                                    'paper_title': '开源自建模拟题 / ' + path.stem.removeprefix('fei-'),
                                    'question_number': None, 'year': int(q['sourceMeta']['year']),
                                    'province': '模拟', 'source_tag': ','.join(tags), 'source_module': q['category'],
                                    'source_url': f"{CONFIG['fei']['repository']}/blob/{CONFIG['fei']['revision']}/src/data/seed/{path.name.removeprefix('fei-')}",
                                    'raw_path': str(path.relative_to(ROOT))}]}


def rejection_reasons(q):
    errors = []
    if q['module'] not in MODULES:
        errors.append('unknown_module')
    if not q['stem_html'].strip():
        errors.append('empty_stem')
    if re.search(r'全力以赴征集|题目正在.*征集|正确答案默认|暂无题目|\*{3,}', q['stem_html']):
        errors.append('incomplete_source_question')
    if len(q['options_html']) < 2 or not q['answer'] or not set(q['answer']) <= q['options_html'].keys():
        errors.append('invalid_options_or_answer')
    if q['question_type'] == 'single' and len(q['answer']) != 1:
        errors.append('invalid_single_answer')
    if q['source_type'] == '真题' and q['module'] == '资料分析' and not q['material_html'].strip():
        errors.append('missing_data_material')
    if 'conflicting_answers' in q['quality_flags']:
        errors.append('conflicting_answers')
    return errors


def export_csv(path, rows):
    fields = ['id', 'module', 'submodule', 'source_type', 'question_type', 'year', 'province',
              'stem', 'A', 'B', 'C', 'D', 'E', 'F', 'answer', 'analysis', 'material', 'material_id',
              'has_image', 'image_paths', 'tags', 'knowledge_points', 'quality_flags',
              'stem_html', 'material_html', 'analysis_html', 'options_html', 'charts', 'sources']
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for q in rows:
            row = {key: q.get(key, '') for key in fields}
            row.update(q['options'])
            row['answer'] = ','.join(q['answer'])
            row['image_paths'] = list(dict.fromkeys(i['path'] for i in q['images']))
            row['sources'] = q['occurrences']
            for key, value in row.items():
                if isinstance(value, (list, dict)):
                    row[key] = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
            writer.writerow(row)


def main():
    assets = json.loads((RAW / 'image_downloads.json').read_text())
    unique, rejected = {}, []
    raw_count = 0
    for q in list(paper_records()) + list(mock_records()):
        raw_count += 1
        identity = '\n'.join([canonical_content(q['material_html']), canonical_content(q['stem_html']),
                              *[key + ':' + canonical_content(value) for key, value in sorted(q['options_html'].items())],
                              json.dumps(q.get('charts', []), ensure_ascii=False, sort_keys=True)])
        key = fingerprint(identity)
        if key in unique:
            existing = unique[key]
            existing['occurrences'].extend(q['occurrences'])
            if existing['answer'] != q['answer']:
                existing['quality_flags'].append('conflicting_answers')
                existing.setdefault('answer_variants', [existing['answer']]).append(q['answer'])
            continue
        q['id'] = 'xc_' + key[:24]
        unique[key] = q
    rows, review = [], []
    for q in unique.values():
        errors = rejection_reasons(q)
        if errors:
            rejected.append({'id': q['id'], 'reasons': sorted(set(errors)), 'occurrences': q['occurrences'],
                             'answer_variants': q.get('answer_variants', [q['answer']])})
            continue
        images = []
        for field in ['stem', 'material', 'analysis']:
            rich, text, refs, issues = normalize_html(q[field + '_html'], field, assets)
            q[field + '_html'], q[field] = rich, text
            images.extend(refs)
            errors.extend(issues)
        q['options'] = {}
        for label, value in q['options_html'].items():
            rich, text, refs, issues = normalize_html(value, 'option_' + label, assets)
            q['options_html'][label], q['options'][label] = rich, text
            images.extend(refs)
            errors.extend(issues)
        if errors:
            rejected.append({'id': q['id'], 'reasons': sorted(set(errors)), 'occurrences': q['occurrences']})
            continue
        # Explicit conflicts between the supplied answer and the final answer in
        # the explanation are recorded for review; source text is never invented.
        found = re.findall(r'(?:故正确答案为|因此[，,]?选择|故选|正确答案是)\s*([A-F]+)', q['analysis'])
        if found and sorted(found[-1]) != q['answer']:
            q['quality_flags'].append('answer_analysis_mismatch')
        q['images'] = list({(i['path'], i['role'], i['kind']): i for i in images}.values())
        q['has_image'] = bool(q['images'])
        q['tags'] = [q['source_type']]
        if images:
            q['tags'] += ['has_image', '含图片']
            q['tags'] += sorted({('option_image' if i['role'].startswith('option_') else i['role'] + '_image') for i in images})
            if any(i['kind'] == 'formula' for i in images):
                q['tags'].append('formula_image')
        if any('<math' in q[field] for field in ['stem_html', 'material_html', 'analysis_html']) or any('<math' in v for v in q['options_html'].values()):
            q['tags'].append('has_mathml')
        if q.get('charts'):
            q['tags'].append('has_chart_data')
        q.setdefault('charts', [])
        q['quality_flags'] = sorted(set(q['quality_flags']))
        q['schema_version'] = '1.0'
        q['material_id'] = 'mat_' + fingerprint(q['material_html'])[:24] if q['material_html'] else None
        q['year'] = q['occurrences'][0]['year']
        q['province'] = q['occurrences'][0]['province']
        q['years'] = sorted({o['year'] for o in q['occurrences'] if o['year']})
        q['provinces'] = sorted({o['province'] for o in q['occurrences']})
        q['answer_verification'] = 'source_only'
        if 'answer_analysis_mismatch' in q['quality_flags']:
            review.append(q)
        else:
            rows.append(q)
    rows.sort(key=lambda q: (MODULES.index(q['module']), q['source_type'], -(q['year'] or 0), q['id']))
    OUT.mkdir(parents=True, exist_ok=True)
    jsonl(OUT / 'questions.jsonl', rows)
    jsonl(OUT / 'needs_review.jsonl', sorted(review, key=lambda q: q['id']))
    export_csv(OUT / 'questions.csv', rows)
    for module, slug in SLUGS.items():
        subset = [q for q in rows if q['module'] == module]
        jsonl(OUT / 'modules' / (slug + '.jsonl'), subset)
        export_csv(OUT / 'modules' / (slug + '.csv'), subset)
    materials = {}
    for q in rows:
        if q['material_id']:
            material = materials.setdefault(q['material_id'], {'id': q['material_id'], 'text': q['material'],
                'html': q['material_html'], 'image_paths': sorted({i['path'] for i in q['images'] if i['role'] == 'material'}),
                'question_ids': []})
            material['question_ids'].append(q['id'])
    jsonl(OUT / 'materials.jsonl', sorted(materials.values(), key=lambda m: m['id']))
    dump(OUT / 'rejected.json', rejected)
    image_paths = {i['path'] for q in rows for i in q['images']}
    stats = {'raw_records': raw_count, 'unique_before_quality_filter': len(unique),
             'duplicate_records_merged': raw_count - len(unique), 'questions': len(rows),
             'rejected_unique_records': len(rejected), 'rejection_reasons': dict(collections.Counter(r for q in rejected for r in q['reasons'])),
             'needs_review_questions': len(review),
             'modules': dict(collections.Counter(q['module'] for q in rows)),
             'source_types': dict(collections.Counter(q['source_type'] for q in rows)),
             'question_types': dict(collections.Counter(q['question_type'] for q in rows)),
             'questions_with_images': sum(q['has_image'] for q in rows), 'unique_images_used': len(image_paths),
             'image_bytes_used': sum((ROOT / p).stat().st_size for p in image_paths), 'materials': len(materials),
             'years': dict(sorted(collections.Counter(str(q['year']) for q in rows).items())),
             'quality_flags': dict(collections.Counter(f for q in rows for f in q['quality_flags'])),
             'submodules': dict(collections.Counter(q['module'] + '/' + q['submodule'] for q in rows)),
             'source_papers': len(list((RAW / 'gongkao' / 'papers').glob('*.json'))),
             'image_download_failures': sum(v['status'] != 'ok' for v in assets.values()),
             'downloaded_unique_images': len({v['path'] for v in assets.values() if v['status'] == 'ok'}),
             'note': '结构和资源校验不代表逐题答案正确性复核；答案、解析及真题属性沿用上游。'}
    dump(OUT / 'stats.json', stats)
    print(json.dumps({k: v for k, v in stats.items() if k != 'submodules'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
