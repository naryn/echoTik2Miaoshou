"""初始化数据库：创建全部数据表（幂等，可重复执行）。

用法：python3 scripts/init_db.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import DATABASE_URL
from app.db import init_db


def main() -> None:
    """执行建表并输出数据库位置。"""
    init_db()
    print(f"数据库已初始化: {DATABASE_URL}")


if __name__ == "__main__":
    main()
