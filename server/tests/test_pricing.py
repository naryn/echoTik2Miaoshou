from app.mcp.pricing_mcp import handle


def test_crossborder_quote_with_gift_weight(client):
    """赠品重量与赠品成本同时生效：返回含赠品价格，赠品成本只进固定成本。"""
    response = client.post("/v1/pricing/crossborder/quote", json={
        "product_cost_rmb": 15,
        "domestic_extra_cost_rmb": 2,
        "mxn_per_rmb": 2.78,
        "quantity": 1,
        "unit_chargeable_weight_kg": 0.2,
        "target_net_margin_pct": 20,
        "merchant_discount_pct": 50,
        "gift_weight_kg": 9,
        "gift_cost_rmb": 30,
    })
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert round(data["recommended_sale_price_mxn"], 2) == 164.42
    assert round(data["recommended_unit_list_price_mxn"], 2) == 228.84
    gift = data["with_gift"]
    assert round(gift["total_chargeable_weight_kg"], 2) == 9.2
    assert round(gift["cost_breakdown_mxn"]["crossborder_shipping"], 2) == 1813
    assert round(gift["cost_breakdown_mxn"]["gift_cost"], 2) == 83.4
    assert round(gift["fixed_cost_mxn"], 2) == 1949.66
    assert round(gift["recommended_sale_price_mxn"], 2) == 3944.99
    assert round(gift["recommended_unit_list_price_mxn"], 2) == 7789.98


def test_crossborder_quote_matches_workbook_example(client):
    """无赠品时与 Excel 模板一示例完全一致。"""
    response = client.post("/v1/pricing/crossborder/quote", json={
        "product_cost_rmb": 15,
        "domestic_extra_cost_rmb": 2,
        "mxn_per_rmb": 2.78,
        "quantity": 1,
        "unit_chargeable_weight_kg": 0.2,
        "target_net_margin_pct": 20,
        "merchant_discount_pct": 50,
    })
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert round(data["unit_product_cost_mxn"], 2) == 47.26
    assert round(data["recommended_sale_price_mxn"], 2) == 164.42
    assert round(data["fixed_cost_mxn"], 2) == 88.26
    assert round(data["gross_margin_pct"], 2) == 46.32
    assert round(data["net_margin_pct"], 2) == 19.36


def test_pricing_mcp_quote_and_volume_tool():
    initialized = handle({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert initialized["result"]["serverInfo"]["name"] == "mx-pop-pricing"
    quote = handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "mx_pop_crossborder_quote", "arguments": {"product_cost_rmb": 15, "quantity": 1, "unit_chargeable_weight_kg": 0.2}}})
    assert quote["result"]["structuredContent"]["recommended_sale_price_mxn"] > 0
    volume = handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "mx_pop_chargeable_weight", "arguments": {"length_cm": 25, "width_cm": 10, "height_cm": 20, "actual_weight_kg": 0.3}}})
    assert volume["result"]["structuredContent"]["is_bubbled"] is True


def test_pricing_page_and_auxiliary_endpoints(client):
    page = client.get("/pricing")
    assert page.status_code == 200
    assert "跨境直邮定价工具" in page.text
    reverse = client.post("/v1/pricing/crossborder/reverse-cost", json={
        "sale_price_mxn": 42, "quantity": 1, "unit_chargeable_weight_kg": 0.62,
    })
    assert reverse.status_code == 200
    assert round(reverse.json()["data"]["max_unit_product_cost_mxn"], 2) == -94.88
    weight = client.post("/v1/pricing/chargeable-weight", json={
        "length_cm": 25, "width_cm": 10, "height_cm": 20, "actual_weight_kg": 0.3,
    })
    assert weight.json()["data"]["chargeable_weight_kg"] == 0.63
