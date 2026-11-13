import os

def top_lnk(root, n):
    """返回 root 下（递归）按字节大小降序的前 n 个 .lnk 文件。"""
    if n <= 0:
        return []
    found = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if not name.lower().endswith(".lnk"):
                continue
            path = os.path.join(dirpath, name)
            try:
                size = os.stat(path).st_size
            except OSError:
                continue
            found.append((path, size))
    found.sort(key=lambda item: item[1], reverse=True)
    return found[:n]
