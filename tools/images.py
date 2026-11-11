#!/usr/bin/env python3
"""Подбор картинок для карт на Wikimedia Commons.

  python3 tools/images.py search [id ...]  – найти кандидатов по запросам из image-queries.json
  python3 tools/images.py list   [id ...]  – показать названия кандидатов
  python3 tools/images.py peek   [id ...]  – скачать миниатюры всех кандидатов и собрать листы
                                             для сравнения (номер на миниатюре = номер кандидата)
  python3 tools/images.py fetch  [id ...]  – скачать выбранную картинку каждой карты
  python3 tools/images.py sheet  [id ...]  – контактные листы для просмотра глазами
  python3 tools/images.py final  [id ...]  – обрезать до 4:3, сохранить img/cards/*.webp,
                                             пересобрать js/credits.js

Выбор хранится в tools/image-picks.json:
  { "<id>": {"file": "File:Name.jpg", "gx": 0.5, "gy": 0.5} }   (gx/gy – центр обрезки)
Вместо "file" можно указать "n" – номер кандидата с листа peek.
Если карты там нет, берётся первый кандидат поиска.

Wikimedia строго ограничивает частоту запросов анонимных скриптов, поэтому между
запросами пауза (переменная PACE, сек), а при ответе 429 ждём, сколько просят.
Рабочая папка – переменная WORK (по умолчанию ./.imgwork, в git не попадает).
"""
import html, json, os, re, subprocess, sys, time, urllib.parse
from PIL import Image, ImageDraw, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get('WORK', os.path.join(ROOT, '.imgwork'))
CANDS = os.path.join(WORK, 'cands')
ORIG = os.path.join(WORK, 'orig')
UA = 'card-game-image-fetcher/1.0 (static hobby project)'
API = 'https://commons.wikimedia.org/w/api.php'
PACE = float(os.environ.get('PACE', '6'))
OUT_W, OUT_H = 480, 360
QUERIES = os.path.join(ROOT, 'tools', 'image-queries.json')
PICKS = os.path.join(ROOT, 'tools', 'image-picks.json')
CREDITS = os.path.join(ROOT, 'tools', 'image-credits.json')
_last = [0.0]


def curl(url, out=None, tries=8):
    """GET с паузами и повторами. При out пишет во временный файл и переименовывает при успехе."""
    tmp = out + '.part' if out else None
    hdr = os.path.join(WORK, 'headers.txt')
    os.makedirs(WORK, exist_ok=True)
    for _ in range(tries):
        wait = PACE - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        cmd = ['curl', '-sS', '-L', '-m', '90', '-A', UA, '-D', hdr, '-w', '%{http_code}', url, '-o', tmp or '-']
        r = subprocess.run(cmd, capture_output=True)
        _last[0] = time.time()
        code = r.stdout[-3:].decode('ascii', 'ignore')
        if code == '200':
            if out:
                os.replace(tmp, out)
            return r.stdout[:-3]
        if code in ('429', '503', '000', '502'):
            retry = 30
            try:
                m = re.findall(r'(?im)^retry-after:\s*(\d+)', open(hdr, errors='ignore').read())
                if m:
                    retry = int(m[-1])
            except OSError:
                pass
            print(f'  … {code}, ждём {retry + 5} с', flush=True)
            time.sleep(min(retry, 900) + 5)
            continue
        raise RuntimeError(f'HTTP {code} for {url}')
    raise RuntimeError(f'gave up on {url}')


def api(params):
    params = dict(params, format='json', formatversion='2')
    return json.loads(curl(API + '?' + urllib.parse.urlencode(params)))


def strip_html(s):
    s = re.sub(r'<[^>]+>', '', s or '')
    return re.sub(r'\s+', ' ', html.unescape(s)).strip()


def thumb_url(info, width):
    name = info['title'].split(':', 1)[1].replace(' ', '_')
    return 'https://commons.wikimedia.org/w/thumb.php?' + urllib.parse.urlencode({'f': name, 'w': min(width, info['width'])})


def page_to_cand(p):
    ii = p['imageinfo'][0]
    md = ii.get('extmetadata', {})
    g = lambda k: strip_html(md.get(k, {}).get('value', ''))
    return {
        'title': p['title'],
        'width': ii['width'],
        'height': ii['height'],
        'page': ii.get('descriptionurl', ''),
        'artist': g('Artist')[:120],
        'license': g('LicenseShortName'),
        'licenseUrl': g('LicenseUrl'),
        'credit': g('Credit')[:120],
        'desc': g('ImageDescription')[:160],
    }


IIPROP = 'url|size|mime|extmetadata'


def search(query, limit=8):
    data = api({
        'action': 'query', 'generator': 'search', 'gsrnamespace': 6,
        'gsrsearch': query + ' filetype:bitmap', 'gsrlimit': 25,
        'prop': 'imageinfo', 'iiprop': IIPROP,
    })
    pages = sorted(data.get('query', {}).get('pages', []), key=lambda p: p.get('index', 0))
    out = []
    for p in pages:
        ii = (p.get('imageinfo') or [None])[0]
        if not ii or ii.get('mime') not in ('image/jpeg', 'image/png'):
            continue
        w, h = ii['width'], ii['height']
        if w < 700 or h < 500 or not (0.62 <= w / h <= 2.4):
            continue
        out.append(page_to_cand(p))
        if len(out) >= limit:
            break
    return out


def by_title(title):
    data = api({'action': 'query', 'titles': title, 'prop': 'imageinfo', 'iiprop': IIPROP})
    p = data['query']['pages'][0]
    if 'imageinfo' not in p:
        raise RuntimeError('no such file: ' + title)
    return page_to_cand(p)


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')


def all_ids():
    return list(load_json(QUERIES, {}))


def cands_of(cid):
    return load_json(os.path.join(CANDS, cid + '.json'), {'query': '', 'cands': []})


def chosen(cid, picks):
    """Метаданные выбранной картинки карты (из выбора или первый кандидат)."""
    meta = cands_of(cid)
    pick = picks.get(cid, {})
    want = pick.get('file')
    if not want:
        # "n" – номер кандидата с листа peek; final заменит его на название файла
        n = pick.get('n', 0)
        return meta['cands'][n] if len(meta['cands']) > n else None
    for c in meta['cands']:
        if c['title'] == want:
            return c
    extra = load_json(os.path.join(CANDS, '_extra.json'), {})
    if want not in extra:
        extra[want] = by_title(want)
        save_json(os.path.join(CANDS, '_extra.json'), extra)
    return extra[want]


def cmd_search(ids):
    queries = load_json(QUERIES, {})
    for cid in ids or list(queries):
        path = os.path.join(CANDS, cid + '.json')
        if not ids and os.path.exists(path) and cands_of(cid)['query'] == queries[cid]:
            continue
        try:
            cands = search(queries[cid])
        except Exception as e:  # noqa
            print('ERR', cid, e, flush=True)
            continue
        save_json(path, {'query': queries[cid], 'cands': cands})
        print(cid, len(cands), '|', cands[0]['title'] if cands else '—', flush=True)


def cmd_list(ids):
    for cid in ids or all_ids():
        meta = cands_of(cid)
        print(f'\n{cid}  [{meta["query"]}]')
        for i, c in enumerate(meta['cands']):
            print(f'  {i}: {c["title"]}  {c["width"]}x{c["height"]}  {c["license"]}  — {c["desc"][:70]}')


def cmd_peek(ids):
    per_card, tw, th, lab, rows = 6, 220, 165, 120, 7
    ids = [i for i in (ids or all_ids()) if cands_of(i)['cands']]
    seen_path = os.path.join(CANDS, '_peek.json')
    seen = load_json(seen_path, {})
    for cid in ids:
        for i, c in enumerate(cands_of(cid)['cands'][:per_card]):
            dst = os.path.join(CANDS, f'{cid}_{i}.jpg')
            if seen.get(f'{cid}_{i}') == c['title'] and os.path.exists(dst):
                continue
            try:
                curl(thumb_url(c, 330), out=dst)
                seen[f'{cid}_{i}'] = c['title']
            except Exception as e:  # noqa
                print('ERR', cid, i, e, flush=True)
        save_json(seen_path, seen)
    sheets = os.path.join(WORK, 'sheets')
    os.makedirs(sheets, exist_ok=True)
    for s in range(0, len(ids), rows):
        chunk = ids[s:s + rows]
        img = Image.new('RGB', (lab + per_card * (tw + 4), len(chunk) * (th + 4)), 'white')
        d = ImageDraw.Draw(img)
        for r, cid in enumerate(chunk):
            y = r * (th + 4)
            for k, line in enumerate(re.findall(r'.{1,18}', cid)):
                d.text((4, y + 4 + 13 * k), line, fill='black')
            for i in range(per_card):
                p = os.path.join(CANDS, f'{cid}_{i}.jpg')
                if seen.get(f'{cid}_{i}') is None or not os.path.exists(p):
                    continue
                try:
                    t = ImageOps.fit(Image.open(p).convert('RGB'), (tw, th), Image.LANCZOS)
                except Exception:  # noqa
                    continue
                x = lab + i * (tw + 4)
                img.paste(t, (x, y))
                d.rectangle((x, y, x + 16, y + 15), fill='black')
                d.text((x + 5, y + 2), str(i), fill='yellow')
        out = os.path.join(sheets, f'peek_{chunk[0]}.jpg')
        img.save(out, quality=78)
        print(out, flush=True)


def orig_path(cid):
    return os.path.join(ORIG, cid + '.jpg')


def cmd_fetch(ids):
    picks = load_json(PICKS, {})
    state_path = os.path.join(ORIG, '_have.json')
    have = load_json(state_path, {})
    os.makedirs(ORIG, exist_ok=True)
    for cid in ids or all_ids():
        try:
            c = chosen(cid, picks)
            if not c:
                print('—', cid, 'нет кандидатов', flush=True)
                continue
            if have.get(cid) == c['title'] and os.path.exists(orig_path(cid)):
                continue
            curl(thumb_url(c, 960), out=orig_path(cid))
        except Exception as e:  # noqa
            print('ERR', cid, e, flush=True)
            continue
        have[cid] = c['title']
        save_json(state_path, have)
        print('ok', cid, c['title'], flush=True)


def cmd_sheet(ids):
    ids = [i for i in (ids or all_ids()) if os.path.exists(orig_path(i))]
    tw, th, cols, rows = 300, 225, 5, 4
    sheets = os.path.join(WORK, 'sheets')
    os.makedirs(sheets, exist_ok=True)
    for f in os.listdir(sheets):
        os.remove(os.path.join(sheets, f))
    picks = load_json(PICKS, {})
    per = cols * rows
    for s in range(0, len(ids), per):
        chunk = ids[s:s + per]
        img = Image.new('RGB', (cols * (tw + 6), rows * (th + 22)), 'white')
        d = ImageDraw.Draw(img)
        for k, cid in enumerate(chunk):
            x, y = (k % cols) * (tw + 6), (k // cols) * (th + 22)
            try:
                p = picks.get(cid, {})
                t = ImageOps.fit(Image.open(orig_path(cid)).convert('RGB'), (tw, th), Image.LANCZOS,
                                 centering=(p.get('gx', 0.5), p.get('gy', 0.5)))
                img.paste(t, (x, y + 18))
            except Exception as e:  # noqa
                d.text((x + 4, y + 40), 'ERR ' + str(e)[:40], fill='red')
            d.text((x + 4, y + 3), cid, fill='black')
        out = os.path.join(sheets, f'sheet_{s // per:02d}.jpg')
        img.save(out, quality=82)
        print(out)


def cmd_final(ids):
    picks = load_json(PICKS, {})
    have = load_json(os.path.join(ORIG, '_have.json'), {})
    credits = load_json(CREDITS, {})
    outdir = os.path.join(ROOT, 'img', 'cards')
    os.makedirs(outdir, exist_ok=True)
    for cid in ids or all_ids():
        if not os.path.exists(orig_path(cid)) or cid not in have:
            print('—', cid, 'не скачана', flush=True)
            continue
        c = chosen(cid, picks)
        if c['title'] != have[cid]:
            print('—', cid, 'скачана другая картинка, нужен fetch', flush=True)
            continue
        p = picks.get(cid, {})
        im = Image.open(orig_path(cid)).convert('RGB')
        im = ImageOps.fit(im, (OUT_W, OUT_H), Image.LANCZOS, centering=(p.get('gx', 0.5), p.get('gy', 0.5)))
        im.save(os.path.join(outdir, cid + '.webp'), 'WEBP', quality=80, method=6)
        picks[cid] = {k: v for k, v in dict(p, file=c['title']).items() if k != 'n'}
        credits[cid] = {
            'file': c['title'], 'page': c['page'],
            'author': c['artist'] or c['credit'] or 'Wikimedia Commons',
            'license': c['license'], 'licenseUrl': c['licenseUrl'],
        }
    save_json(PICKS, picks)
    save_json(CREDITS, credits)
    slim = {k: {'a': v['author'], 'l': v['license'], 'lu': v['licenseUrl'], 'p': v['page']} for k, v in sorted(credits.items())}
    with open(os.path.join(ROOT, 'js', 'credits.js'), 'w', encoding='utf-8') as f:
        f.write('// Сгенерировано tools/images.py — не править вручную.\n')
        f.write('// a: автор, l: лицензия, lu: ссылка на лицензию, p: страница файла на Wikimedia Commons\n')
        f.write('export const CREDITS = ' + json.dumps(slim, ensure_ascii=False, indent=1) + ';\n')
    print('готово:', len(os.listdir(outdir)), 'картинок')


if __name__ == '__main__':
    cmds = {'search': cmd_search, 'list': cmd_list, 'peek': cmd_peek, 'fetch': cmd_fetch, 'sheet': cmd_sheet, 'final': cmd_final}
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd in cmds:
        cmds[cmd](sys.argv[2:])
    else:
        print(__doc__)
