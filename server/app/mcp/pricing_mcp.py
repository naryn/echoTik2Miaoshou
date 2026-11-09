"""零依赖 stdio MCP server，向 agent 提供 MX POP 定价与计泡工具。

运行：python -m app.mcp.pricing_mcp
传输：stdin/stdout，每行一个 JSON-RPC 2.0 消息（stdout 不输出日志）。
"""

from __future__ import annotations

import json
import sys
from typing import Any

from app.services.pricing_service import chargeable_weight_kg, quote_crossborder


_QUOTE_SCHEMA = {
    "type": "object",
    "required": ["product_cost_rmb", "quantity", "unit_chargeable_weight_kg"],
    "properties": {
        "product_cost_rmb": {"type": "number", "description": "单件商品成本（RMB）"},
        "domestic_extra_cost_rmb": {"type": "number", "default": 2},
        "mxn_per_rmb": {"type": "number", "default": 2.78},
        "quantity": {"type": "integer", "default": 1},
        "unit_chargeable_weight_kg": {"type": "number", "description": "单件计费重量（kg）"},
        "target_net_margin_pct": {"type": "number", "default": 20},
        "merchant_discount_pct": {"type": "number", "default": 50},
        "new_customer_discount_pct": {"type": "number", "default": 0},
        "affiliate_commission_pct": {"type": "number", "default": 0},
        "advertising_pct": {"type": "number", "default": 0},
        "buyer_shipping_paid_per_item_mxn": {"type": "number", "default": 50},
    },
}


def _result(request_id: Any, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": message}}


def handle(message: dict) -> dict | None:
    """处理单个 MCP JSON-RPC 消息；供自动化测试及 stdio 循环调用。"""
    request_id = message.get("id")
    method = message.get("method")
    if method == "notifications/initialized":
        return None
    if method == "initialize":
        return _result(request_id, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "mx-pop-pricing", "version": "1.0.0"}})
    if method == "tools/list":
        return _result(request_id, {"tools": [
            {"name": "mx_pop_crossborder_quote", "description": "计算 MX POP 跨境直邮售价、固定成本、毛利/毛利率、销售变动费用与净利/净利率。", "inputSchema": _QUOTE_SCHEMA},
            {"name": "mx_pop_chargeable_weight", "description": "根据长宽高、实际重判断是否计泡，并返回应使用的计费重量。", "inputSchema": {"type": "object", "required": ["length_cm", "width_cm", "height_cm", "actual_weight_kg"], "properties": {"length_cm": {"type": "number"}, "width_cm": {"type": "number"}, "height_cm": {"type": "number"}, "actual_weight_kg": {"type": "number"}}}},
        ]})
    if method == "tools/call":
        params = message.get("params", {})
        name, arguments = params.get("name"), params.get("arguments", {})
        try:
            if name == "mx_pop_crossborder_quote":
                data = quote_crossborder({"domestic_extra_cost_rmb": 2, "mxn_per_rmb": 2.78, "quantity": 1, "target_net_margin_pct": 20, "merchant_discount_pct": 50, "new_customer_discount_pct": 0, "affiliate_commission_pct": 0, "advertising_pct": 0, "buyer_shipping_paid_per_item_mxn": 50, **arguments})
            elif name == "mx_pop_chargeable_weight":
                data = chargeable_weight_kg(**arguments)
            else:
                return _error(request_id, f"未知工具：{name}")
            return _result(request_id, {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "structuredContent": data})
        except (KeyError, TypeError, ValueError) as exc:
            return _error(request_id, str(exc))
    return _error(request_id, f"不支持的方法：{method}")


def main() -> None:
    for line in sys.stdin:
        try:
            response = handle(json.loads(line))
            if response is not None:
                print(json.dumps(response, ensure_ascii=False), flush=True)
        except json.JSONDecodeError as exc:
            print(json.dumps(_error(None, f"JSON 无法解析：{exc.msg}"), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
