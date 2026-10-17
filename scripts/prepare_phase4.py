#!/usr/bin/env python3
"""整理四期补充任务：合并 OCR、保留 OCR 框，并拷贝标注站静态图片。"""
import csv
import json
import re
import shutil
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SUPPLEMENT = ROOT / '补充'
IMAGES = ROOT / 'guji-ocr-annotation/public/images'
TASKS = ROOT / 'guji-ocr-annotation/supabase/tasks.csv'
PHASE_CSV = SUPPLEMENT / '四期补充.csv'
OCR_RESULTS = SUPPLEMENT / '补录_OCR结果/results.jsonl'
HANYUAN = Path('/Users/zhuoning/Desktop/dingshuji_bench/翰苑遺事')
PROJECT = HANYUAN / '2026-09-12-人工異文查驗備份/project.json'
WENYUANGE = HANYUAN / '2026-09-12-高清原圖備份/wenyuange/pages'
BAOJINGLOU = HANYUAN / '2026-09-12-高清原圖備份/baojinglou/pages'
MINGCHAO = HANYUAN / '2026-09-12-高清原圖備份/mingchaoben/pages'
XUANDE_HTML = Path('/Users/zhuoning/Desktop/dingshuji_bench/文选/卷 36_任彦升《宣德皇后令》/校对重做/宣德皇后令_逐页校对.html')
FIELDS = ['sample_id', 'image_path', 'original_filename', 'batch', 'note', 'ocr_initial', 'corrected_text', 'status', 'labels', 'annotator_name', 'reviewer_note', 'bert_alerts']


def natural_key(path: Path):
    return [int(x) if x.isdigit() else x.lower() for x in re.split(r'(\d+)', path.name)]


def layout(width, height, lines):
    """保留原 OCR 的行框、字框及置信度，供前端叠加显示。"""
    return {
        'width': width,
        'height': height,
        'lines': [
            {
                'text': line.get('text', ''),
                'position': line.get('position'),
                'words': [
                    {'text': word.get('text', ''), 'position': word.get('position'),
                     'confidence': word.get('confidence')}
                    for word in line.get('words', [])
                ],
            }
            for line in lines
        ],
    }


def load_ocr_results():
    result = {}
    for line in OCR_RESULTS.read_text(encoding='utf-8').splitlines():
        item = json.loads(line)
        if item.get('status') != 'success':
            raise RuntimeError(f"OCR 失败：{item.get('source_image')}: {item.get('error')}")
        result[item['source_image']] = item
    if len(result) != 40:
        raise RuntimeError(f'预期 40 条补录 OCR，实际 {len(result)} 条')
    return result


def hanyuan_pages():
    project = json.loads(PROJECT.read_text(encoding='utf-8'))
    versions = {v['id']: v for v in project['versions']}
    picked = [
        ('wenyuange', WENYUANGE, [10, 8, 9, 11, 12], '文渊阁本'),
        ('baojinglou', BAOJINGLOU, [16, 17, 18], '抱经楼本'),
        ('mingchaoben', MINGCHAO, [13, 14], '明钞本'),
    ]
    pages = []
    for version_id, directory, numbers, label in picked:
        ocr = {item['page']: item for item in versions[version_id]['ocrPages']}
        for number in numbers:
            page = ocr[number]
            source = directory / f'page-{number:02d}.jpg'
            if not source.exists():
                raise FileNotFoundError(source)
            pages.append((source, f'四库《翰苑遺事》{label}第{number}页', page))
    return pages


def xuande_pages():
    from bs4 import BeautifulSoup
    import base64
    soup = BeautifulSoup(XUANDE_HTML.read_text(encoding='utf-8'), 'html.parser')
    data = json.loads(soup.find(id='data').string)
    export_dir = SUPPLEMENT / '四期补充图片'
    pages = []
    # HTML 第 1、26 页按要求不纳入；其余页此前已导出，这里仅重新读取文字。
    for page in data['pages'][1:-1]:
        source = export_dir / f'日本古钞本_文选卷36_第{page["page"]}页.jpg'
        # 兼容此前带旧编号的导出文件。
        candidates = list(export_dir.glob(f'*日本古钞本_文选卷36_第{page["page"]}页.jpg'))
        if candidates:
            source = candidates[0]
        if not source.exists():
            header, encoded = page['image'].split(',', 1)
            source = export_dir / f'日本古钞本_文选卷36_第{page["page"]}页.jpg'
            source.write_bytes(base64.b64decode(encoded))
        corrected = ''.join(x['char'] for x in data['characters'][page['start']:page['end']])
        initial = '\n'.join(data['lines'][i]['text'] for i in page['lines'])
        pages.append((source, f'日本古钞本《文选》卷36〈宣德皇后令〉；HTML 原 PDF 第{page["page"]}页', initial, corrected))
    return pages


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)
    ocr = load_ocr_results()
    rows = []
    sample_id = 548

    def add(source, note, initial='', corrected='', labels=None):
        nonlocal sample_id
        target_name = f'{sample_id}{source.suffix.lower()}'
        shutil.copy2(source, IMAGES / target_name)
        rows.append({
            'sample_id': sample_id, 'image_path': target_name, 'original_filename': source.name,
            'batch': '四期', 'note': note, 'ocr_initial': initial, 'corrected_text': corrected,
            'status': '待标注', 'labels': json.dumps(labels or {}, ensure_ascii=False, separators=(',', ':')),
            'annotator_name': '', 'reviewer_note': '', 'bert_alerts': '[]',
        })
        sample_id += 1

    # 1. 古籍补录：必须排在四期最前；OCR 原始框保存在 labels.__ocr_layout。
    for source in sorted(SUPPLEMENT.glob('补录*.png'), key=natural_key):
        item = ocr[source.name]
        text = '\n'.join(line.get('text', '') for line in item.get('lines', []))
        add(source, '四期：古籍补录（保留 Kandianguji OCR 原始框）', text, text,
            {'__ocr_layout': layout(item['image_width'], item['image_height'], item.get('lines', []))})

    # 2. 四库、明钞本、抱经堂本；使用对应项目 JSON 的逐页 OCR 与框坐标。
    for source, description, page in hanyuan_pages():
        text = page.get('text', '')
        add(source, f'四期：{description}（项目原始 OCR）', text, text,
            {'__ocr_layout': layout(page['imageWidth'], page['imageHeight'], page.get('words', []))})

    # 3. 敦煌：按截图时间排序后取奇数位，仅图像。
    dunhuang = sorted(SUPPLEMENT.joinpath('敦煌').glob('*.png'), key=lambda p: datetime.strptime(
        re.search(r'(\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2})', p.name).group(1), '%Y-%m-%d %H.%M.%S'))
    for position, source in enumerate(dunhuang, 1):
        if position % 2:
            add(source, f'四期：敦煌钞本；按截图时间排序后取第 {position} 张（仅图像）')

    # 4. 日本古钞本：HTML 首尾页已剔除。
    for source, note, initial, corrected in xuande_pages():
        add(source, f'四期：{note}', initial, corrected, {'制作方式': '稿抄本', '时代': '其他：日本'})

    # 5. 碑刻：仅图像。
    for source in sorted(SUPPLEMENT.joinpath('碑刻').glob('碑刻*.png'), key=natural_key):
        add(source, '四期：碑刻（仅图像）')

    if len(rows) != 97 or sample_id != 645:
        raise RuntimeError(f'四期条数或编号错误：{len(rows)} 条，末编号 {sample_id - 1}')
    with PHASE_CSV.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader(); writer.writerows(rows)

    with TASKS.open(encoding='utf-8-sig', newline='') as handle:
        existing = list(csv.DictReader(handle))
    existing = [row for row in existing if int(row['sample_id']) < 548]
    if len(existing) != 547:
        raise RuntimeError(f'现有 tasks.csv 应有 547 条，实际 {len(existing)} 条')
    with TASKS.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader(); writer.writerows(existing); writer.writerows(rows)
    print(f'四期 {len(rows)} 条：{PHASE_CSV}')
    print(f'全量 {len(existing) + len(rows)} 条：{TASKS}')


if __name__ == '__main__':
    main()
