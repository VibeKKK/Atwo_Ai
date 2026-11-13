import sys, os
sys.path.insert(0, '.')
from trae_mod import top_lnk
top = top_lnk(r"D:\快捷", 5)
print("前5条:")
for p, s in top:
    print("  ", s, os.path.basename(p).encode('gbk', 'replace').decode('gbk'))
print("总数:", len(top_lnk(r"D:\快捷", 9999)))
