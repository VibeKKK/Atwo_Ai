import os


def top_lnk(root, n):
    if n <= 0:
        return []
    matches = []
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith('.lnk'):
                path = os.path.join(dirpath, name)
                try:
                    matches.append((path, os.path.getsize(path)))
                except OSError:
                    continue
    matches.sort(key=lambda item: item[1], reverse=True)
    return matches[:n]
