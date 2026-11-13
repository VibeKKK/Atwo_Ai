import sys, os
sys.path.insert(0, '.')
from cb_mod import top_lnk
r = top_lnk(r"D:\快捷", 5)
print("条数(前5):", len(r))
for p, s in r:
    print("  ", s, os.path.basename(p))
