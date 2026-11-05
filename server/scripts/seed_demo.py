"""生成演示数据：1 客户端、1 快照、20 商品、1 批次（5 任务）。

用法：python3 scripts/seed_demo.py
"""

import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import SessionLocal, init_db
from app.services import batch_service, client_service, rank_service


def main() -> None:
    """写入演示数据并打印关键 ID 与客户端凭证。"""
    init_db()
    db = SessionLocal()
    try:
        client = client_service.register_client(
            db, install_id=str(uuid.uuid4()), display_name="演示客户端", extension_version="0.1.0"
        )

        snapshot, _ = rank_service.create_snapshot(
            db,
            client_id=client.client_id,
            request_id=f"seed-{uuid.uuid4().hex}",
            region="US",
            ranking_type="DAILY",
            category_id="cat-demo",
            period_start="2026-11-03",
            period_end="2026-11-03",
            filter_json={"source": "seed_demo"},
        )

        entries = [
            {
                "external_product_id": f"1732052189{i:07d}",
                "title": f"演示商品 {i + 1}",
                "shop_id": "shop-demo",
                "shop_name": "演示店铺",
                "detail_url": f"https://www.tiktok.com/shop/pdp/1732052189{i:07d}",
                "rank_position": i + 1,
                "sales": 1000 - i * 10,
                "gmv": float((1000 - i * 10) * 9.9),
            }
            for i in range(20)
        ]
        result = rank_service.upsert_entries(db, snapshot, entries)
        rank_service.finish_snapshot(db, snapshot, "COMPLETED")

        from sqlalchemy import select

        from app.models import Product

        product_ids = db.execute(select(Product.id).limit(5)).scalars().all()
        batch, _, _ = batch_service.create_batch(
            db,
            client_id=client.client_id,
            idempotency_key=f"seed-{uuid.uuid4().hex}",
            product_ids=product_ids,
        )

        print(f"客户端: {client.client_id}  token: {client.client_token}")
        print(f"快照: {snapshot.snapshot_id}  明细入库: {result['accepted']} 条")
        print(f"批次: {batch.batch_id}  任务数: {len(product_ids)}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
