"""extract.json → ../data.xml 변환.
사용: py scripts\convert.py  (또는 cd scripts; py convert.py)
"""
import json, re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
extract = json.loads((HERE / "extract.json").read_text(encoding="utf-8"))
cells = extract["cells"]

COLORS = ['#fde68a','#a7f3d0','#bfdbfe','#fbcfe8','#ddd6fe',
          '#fed7aa','#fecaca','#bae6fd','#bbf7d0','#e9d5ff']

# ---------- 1) 컬럼 → 연도 (R4 헤더 기반) ----------
def parse_col_header(text):
    t = text.strip().replace('\n', ' ')
    if t == '0': return 0
    is_bc = 'BC' in t
    t = t.replace('BC', '').replace('AD', '').strip()
    m = re.search(r'\d+', t)
    if not m: return None
    return -int(m.group(0)) if is_bc else int(m.group(0))

col_year = {}
for c in cells:
    if c['r1'] == 4 and c['c1'] >= 5:
        y = parse_col_header(c['v'])
        if y is not None:
            col_year[c['c1']] = y

zero_col = next((c for c, y in sorted(col_year.items()) if y == 0), None)
if zero_col:
    for c in list(col_year.keys()):
        if c < zero_col and col_year[c] > 0:
            col_year[c] = -col_year[c]

cols_sorted = sorted(col_year.keys())

def col_to_year(c):
    if c in col_year: return col_year[c]
    less = [cc for cc in cols_sorted if cc <= c]
    return col_year[less[-1]] if less else None

def col_end(c):
    nxt = [cc for cc in cols_sorted if cc > c]
    if nxt: return col_year[nxt[0]]
    return col_year[cols_sorted[-1]] + 50

# ---------- 2) 행 → 지역/나라 ----------
def norm(s):
    return re.sub(r'\s+', ' ', (s or '').replace('\n', ' ')).strip()

regions_by_row = {}
countries_by_row = {}
for c in cells:
    if c['c1'] == 2 and c['r1'] >= 7:
        nm = norm(c['v'])
        for r in range(c['r1'], c['r2'] + 1):
            regions_by_row[r] = nm
    elif c['c1'] == 3 and c['r1'] >= 7:
        nm = norm(c['v'])
        for r in range(c['r1'], c['r2'] + 1):
            countries_by_row[r] = nm

if not countries_by_row:
    raise SystemExit("WARN: no countries found")

max_row = max(max(regions_by_row.keys(), default=0), max(countries_by_row.keys(), default=0))

row_cid = {}
country_defs = []
seen_pos = {}
for r in range(7, max_row + 1):
    rname = regions_by_row.get(r)
    cname = countries_by_row.get(r)
    if not rname or not cname: continue
    key = (rname, cname)
    seen_pos[key] = seen_pos.get(key, 0) + 1
    idx = seen_pos[key]
    cid = f'c_{len(country_defs)+1}'
    display = cname if idx == 1 else f'{cname} ({idx})'
    country_defs.append({'id': cid, 'name': display, 'region': rname})
    row_cid[r] = cid

region_defs = []
seen_r = set()
for r in sorted(regions_by_row.keys()):
    nm = regions_by_row[r]
    if nm not in seen_r:
        seen_r.add(nm)
        region_defs.append({'id': f'r_{len(region_defs)+1}', 'name': nm})
region_id = {rd['name']: rd['id'] for rd in region_defs}

# ---------- 3) 엔트리 이름에서 연도 파싱 ----------
def parse_year_token(s):
    s = re.sub(r'(년|경|\?|\s)', ' ', s).strip()
    is_bc = 'BC' in s
    s = s.replace('BC', '').replace('AD', '').strip()
    m = re.search(r'(\d+)\s*세기', s)
    if m:
        n = int(m.group(1))
        return -n * 100 if is_bc else (n - 1) * 100
    m = re.search(r'\d+', s)
    if not m: return None
    n = int(m.group(0))
    return -n if is_bc else n

def parse_period(name, fb_start, fb_end):
    cleaned = name.replace('\n', ' ')
    for paren in re.findall(r'\(([^)]+)\)', cleaned):
        if '~' not in paren: continue
        left, right = paren.split('~', 1)
        left = left.strip(); right = right.strip()
        sy = parse_year_token(left)
        if sy is None: continue
        ey = None
        if 'BC' in right or 'AD' in right or '세기' in right:
            ey = parse_year_token(right)
        else:
            m = re.search(r'\d+', right)
            if m:
                rv = int(m.group(0))
                if sy < 0 and rv <= abs(sy):
                    ey = -rv
                else:
                    ey = rv
        if ey is not None:
            if ey < sy: ey = sy + 50
            return sy, ey
    return fb_start, fb_end

# ---------- 4) 엔트리 ----------
entries = []
for c in cells:
    r1, r2, c1, c2, v = c['r1'], c['r2'], c['c1'], c['c2'], c['v']
    if c1 < 5 or r1 < 7: continue
    if v.strip() in ('-', '–', '—'): continue

    cs = col_to_year(c1); ce = col_end(c2)
    if cs is None: continue

    cids = []
    for r in range(r1, r2 + 1):
        cid = row_cid.get(r)
        if cid and cid not in cids:
            cids.append(cid)
    if not cids: continue

    sy, ey = parse_period(v, cs, ce)
    first_line = v.split('\n')[0].strip()
    desc = v.split('\n', 1)[1].strip() if '\n' in v else ''

    entries.append({
        'id': f'e_{len(entries)+1}',
        'name': first_line,
        'startYear': sy,
        'endYear': ey,
        'countryIds': cids,
        'description': desc,
    })

# ---------- 5) 사건 ----------
events = []
def extract_event(cell):
    v = cell['v']
    cleaned = v.replace('\n', ' ')
    year = None
    m = re.search(r'\((BC\s*)?(\d+)', cleaned)
    if m:
        year = int(m.group(2))
        if m.group(1): year = -year
        elif cell['c1'] < (zero_col or 33): year = -year
    if year is None:
        year = col_to_year(cell['c1'])
    return year

for c in cells:
    if c['r1'] not in (2, 3, 6): continue
    if c['c1'] < 5: continue
    yr = extract_event(c)
    if yr is None: continue
    nm = re.sub(r'\s+', ' ', c['v'].replace('\n', ' ')).strip()
    nm = re.sub(r'\s*\([^)]*\d[^)]*\)\s*', '', nm).strip()
    if not nm or nm in ('BC', 'AD', 'BC -> AD', '-'): continue
    events.append({'id': f'ev_{len(events)+1}', 'year': yr, 'name': nm})

# ---------- 6) 타임라인 범위 ----------
all_y = ([e['startYear'] for e in entries] + [e['endYear'] for e in entries] +
         [ev['year'] for ev in events] + list(col_year.values()))
start_year = (min(all_y) // 100) * 100 if all_y else -3000
end_year   = ((max(all_y) // 100) + 1) * 100 if all_y else 2100

# ---------- 7) XML ----------
def esc(s):
    if s is None: return ''
    return (str(s).replace('&', '&amp;').replace('<', '&lt;')
                  .replace('>', '&gt;').replace('"', '&quot;'))

out = ['<?xml version="1.0" encoding="UTF-8"?>',
       '<!-- 엑셀(My World History.xlsx)에서 자동 변환된 데이터. 필요 시 직접 수정 가능. -->',
       f'<timeline start="{start_year}" end="{end_year}">', '']

out.append('  <regions>')
for r in region_defs:
    out.append(f'    <region id="{r["id"]}" name="{esc(r["name"])}"/>')
out.append('  </regions>'); out.append('')

out.append('  <countries>')
for cd in country_defs:
    rid = region_id.get(cd['region'])
    if not rid: continue
    out.append(f'    <country id="{cd["id"]}" region="{rid}" name="{esc(cd["name"])}"/>')
out.append('  </countries>'); out.append('')

out.append('  <entries>')
for i, e in enumerate(entries):
    color = COLORS[i % len(COLORS)]
    cids = ' '.join(e['countryIds'])
    base = (f'id="{e["id"]}" name="{esc(e["name"])}" '
            f'start="{e["startYear"]}" end="{e["endYear"]}" '
            f'countries="{cids}" color="{color}"')
    if e['description']:
        out.append(f'    <entry {base}>')
        out.append(f'      <description>{esc(e["description"])}</description>')
        out.append(f'    </entry>')
    else:
        out.append(f'    <entry {base}/>')
out.append('  </entries>'); out.append('')

out.append('  <events>')
for ev in events:
    out.append(f'    <event id="{ev["id"]}" year="{ev["year"]}" name="{esc(ev["name"])}"/>')
out.append('  </events>'); out.append('')
out.append('</timeline>')

(ROOT / 'data.xml').write_text('\n'.join(out), encoding='utf-8')

print(f"regions={len(region_defs)} countries={len(country_defs)} entries={len(entries)} events={len(events)}")
print(f"timeline range: {start_year} ~ {end_year}")
print(f"-> {ROOT / 'data.xml'}")
