import os
from PIL import Image

targets = [
    (r"C:\Users\DFWJ\OneDrive\图片\134230616_p1_master1200.jpg", r"D:/AIagent/DeepSeek/wishadel-theme/assets/wishadel-board-overlay.jpg", 1600),
    (r"C:\Users\DFWJ\OneDrive\图片\135865171_p0_master1200.jpg", r"D:/AIagent/DeepSeek/wishadel-theme/assets/wishadel-git-overlay.jpg", 1600),
    (r"C:\Users\DFWJ\OneDrive\图片\123259930_p1.png", r"D:/AIagent/DeepSeek/wishadel-theme/assets/wishadel-tree-bg.jpg", 1000),
]
for src, dst, maxw in targets:
    if not os.path.exists(src):
        print("SKIP missing", src)
        continue
    im = Image.open(src).convert("RGB")
    w, h = im.size
    if w > maxw:
        im = im.resize((maxw, int(h * maxw / w)), Image.LANCZOS)
    im.save(dst, quality=86, optimize=True)
    print("saved", dst, im.size)
