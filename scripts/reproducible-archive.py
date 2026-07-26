#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/reproducible-archive.py in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

"""Create a deterministic Package tarball from an already validated staging tree.

The caller supplies the staging parent, top-level Package ID, output path, and
the Package-relative paths that must retain executable mode. Manifest, target,
artifact, and checksum validation remain the Package Manager's responsibility.
"""

import argparse
import gzip
import os
import sys
import tarfile

# 024 §2.1：一切隨機/隨環境的東西都要按死
MTIME = 0
UID = GID = 0
UNAME = GNAME = ""      # 不許洩漏構建機的用戶名
DIR_MODE = 0o755
FILE_MODE = 0o644
EXEC_MODE = 0o755
GZIP_LEVEL = 1          # §2.1；大 ctx 包也要能在預算內打完


def walk_sorted(root):
    """
    按**包內相對路徑的 UTF-8 位元組序**排序（§2.1）。
    不用 os.walk 的天然順序——那是檔案系統給的，換台機器就變。
    """
    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in dirnames + filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            entries.append((rel.encode("utf-8"), full, rel))
    entries.sort(key=lambda e: e[0])
    return [(full, rel) for _, full, rel in entries]


def build(root, top, out, execs):
    execs = {e.strip("/") for e in execs}
    src = os.path.join(root, top)
    if not os.path.isdir(src):
        sys.exit(f"ERROR: staging top-level dir not found: {src}")

    # 串流寫出：tar → gzip → 檔案。不進記憶體緩衝——大 ctx 包有 479MB。
    # gzip header 也會洩漏時間與原始檔名，一併按死（§2.1）。
    with open(out, "wb") as fh, \
         gzip.GzipFile(filename="", mode="wb", compresslevel=GZIP_LEVEL, fileobj=fh, mtime=MTIME) as gz, \
         tarfile.open(fileobj=gz, mode="w|", format=tarfile.GNU_FORMAT) as tar:
        def add(full, arcname, is_dir):
            info = tarfile.TarInfo(arcname)
            st = os.lstat(full)
            if os.path.islink(full):
                # 022 紅線：tar 內不許有鏈接。這裡再攔一次（pack 側已攔，但歸檔是最後一道）
                sys.exit(f"ERROR: symlink not allowed in package: {arcname}")
            info.mtime = MTIME
            info.uid = info.gid = UID
            info.uname = UNAME
            info.gname = GNAME
            if is_dir:
                info.type = tarfile.DIRTYPE
                info.mode = DIR_MODE
                info.size = 0
                tar.addfile(info)
            else:
                info.type = tarfile.REGTYPE
                rel = arcname.split("/", 1)[1] if "/" in arcname else ""
                info.mode = EXEC_MODE if rel in execs else FILE_MODE
                info.size = st.st_size
                with open(full, "rb") as f:
                    tar.addfile(info, f)

        add(src, top, True)
        for full, rel in walk_sorted(src):
            arcname = f"{top}/{rel}"
            add(full, arcname, os.path.isdir(full))


def main():
    ap = argparse.ArgumentParser(description="Deterministic package archiver (024 §2)")
    ap.add_argument("--root", required=True, help="staging 父目錄")
    ap.add_argument("--top", required=True, help="唯一頂層目錄名（= package id）")
    ap.add_argument("--out", required=True, help="輸出 tar.gz")
    ap.add_argument("--exec", action="append", default=[], dest="execs",
                    help="包內相對路徑，設為 0755（Manifest runtime.bundled type=executable）")
    a = ap.parse_args()
    build(a.root, a.top, a.out, a.execs)


if __name__ == "__main__":
    main()
