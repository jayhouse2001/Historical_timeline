"""
BC era로 표기되어야 하지만 AD로 잘못 들어간 entry들의 start/end를 보정.
이 스크립트는 1회성 패치 — convert.py가 이미 고쳐졌으므로 다음 import부턴 자동.
"""
import re
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / 'data' / 'data.xml'

# (id, new_start, new_end)
FIXES = [
    ('e_60', -1600, -1180),  # 히타이트 제국 (1600 ~ 1180)
    ('e_61', -1200, -700),   # 신히타이트 (12세기 ~ 8세기)
    ('e_63', -334,  -323),   # 알렉산드로스
    ('e_68', -2000, -1500),  # 고대 아시리아 (20세기 ~ 15세기)
    ('e_70', -934,  -609),   # 신아시리아 (934 ~ 609)
    ('e_71', -312,  -63),    # 셀레우코스 제국
    ('e_79', -2900, -2500),  # 수메르 문명 시작
    ('e_80', -1895, -1595),  # 바빌론 제국 (1895 ~ 1595)
    ('e_81', -1595, -626),   # 중기 바빌로니아
    ('e_82', -626,  -539),   # 신바빌로니아
    ('e_99', -1100, -700),   # 암흑기 (11세기 ~ 8세기)
]

xml = DATA.read_text(encoding='utf-8')

for eid, ns, ne in FIXES:
    pat = re.compile(rf'(<entry\s+id="{re.escape(eid)}"[^>]*?)\sstart="-?\d+"\s+end="-?\d+"')
    new = pat.sub(rf'\1 start="{ns}" end="{ne}"', xml)
    if new == xml:
        print(f'  - {eid}: no change (already fixed or pattern mismatch)')
    else:
        print(f'  OK {eid}: start={ns} end={ne}')
        xml = new

DATA.write_text(xml, encoding='utf-8')
print(f'-> {DATA}')
