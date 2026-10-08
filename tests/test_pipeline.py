import json
import sys
import unittest
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from build_dataset import canonical_content, jsonl, normalize_html, parse_static_ts, plain_text
from download_images import canonical_url


class PipelineTests(unittest.TestCase):
    def test_image_roles_and_local_path(self):
        url = 'https://example.com/diagram.png'
        assets = {url: {'status': 'ok', 'path': 'assets/images/ab/test.png', 'width': 42, 'height': 20}}
        rich, text, images, issues = normalize_html('<p>题目<img src="//example.com/diagram.png" onerror="alert(1)"></p>', 'option_B', assets)
        self.assertIn('assets/images/ab/test.png', rich)
        self.assertIn('assets/images/ab/test.png', text)
        self.assertNotIn('example.com', rich)
        self.assertNotIn('onerror', rich)
        self.assertEqual(images[0]['role'], 'option_B')
        self.assertFalse(issues)

    def test_missing_image_is_not_silently_accepted(self):
        rich, _, _, issues = normalize_html('<img src="https://example.com/missing.png">', 'stem', {})
        self.assertEqual(issues, ['image_download_failed'])
        self.assertNotIn('https:', rich)

    def test_math_fraction_preserved(self):
        source = '<math><mfrac><mn>100</mn><mrow><mn>1</mn><mo>+</mo><mn>20%</mn></mrow></mfrac></math>'
        self.assertEqual(plain_text(source), '(100)/(1+20%)')

    def test_static_ts_literal_without_code_execution(self):
        source = "export const test: Question[] = [{id: 'a', value: '逗号,}', reviewed: true,},];"
        self.assertEqual(parse_static_ts(source), [{'id': 'a', 'value': '逗号,}', 'reviewed': True}])
        with self.assertRaises(ValueError):
            parse_static_ts('export const test: Question[] = [process.exit(0)];')

    def test_dedup_keeps_different_figures_distinct(self):
        first = canonical_content('<p>题目</p><img src="//example.com/a.png">')
        second = canonical_content('题目<img src="https://example.com/a.png">')
        third = canonical_content('题目<img src="https://example.com/b.png">')
        self.assertEqual(first, second)
        self.assertNotEqual(first, third)

    def test_full_size_picture_and_formula_query(self):
        self.assertEqual(canonical_url('//fb.fbstatic.cn/api/tarzan/images/test.png?width=700'),
                         'https://fb.fbstatic.cn/api/tarzan/images/test.png')
        formula = 'https://example.com/formulas?latex=a%2Bb&fontSize=18'
        self.assertEqual(canonical_url(formula), formula)

    def test_jsonl_unicode_line_separators(self):
        rows = [{'text': '第一段\u2028第二段\u2029第三段\u0085第四段'}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.jsonl'
            jsonl(path, rows)
            lines = path.read_text().splitlines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0]), rows[0])


if __name__ == '__main__':
    unittest.main()
