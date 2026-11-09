"""MX POP 跨境直邮定价领域服务；REST 与 MCP 共用此处的唯一公式实现。"""

from __future__ import annotations

from math import ceil


_SHIPPING_STEPS: tuple[tuple[float, float], ...] = (
    (0.1, 14), (0.2, 35), (0.3, 54), (0.4, 71), (0.5, 90),
    (0.6, 108), (0.7, 126), (0.8, 145), (0.9, 163), (1.0, 180),
    (1.5, 212), (2.0, 327), (3.0, 453), (4.0, 717), (5.0, 838),
)


def shipping_cost_mxn(total_weight_kg: float) -> float:
    """按 2026-10-21 价卡计算跨境物流成本。"""
    if not 0 < total_weight_kg <= 30:
        raise ValueError("包裹总计费重量必须大于 0kg 且不超过 30kg")
    for upper_weight, fee in _SHIPPING_STEPS:
        if total_weight_kg <= upper_weight:
            return fee
    return 838 + ceil(total_weight_kg - 5) * 195


def chargeable_weight_kg(length_cm: float, width_cm: float, height_cm: float, actual_weight_kg: float) -> dict:
    """根据原表计泡规则返回应使用的计费重量。"""
    if min(length_cm, width_cm, height_cm) < 0 or actual_weight_kg <= 0:
        raise ValueError("尺寸必须非负且实际重量必须大于 0")
    volumetric = length_cm * width_cm * height_cm / 8000
    ratio = volumetric / actual_weight_kg
    is_bubbled = ratio > 1.5
    selected = volumetric if is_bubbled else actual_weight_kg
    rounded = ceil(selected * 100 - 1e-9) / 100
    return {
        "volumetric_weight_kg": volumetric,
        "volumetric_to_actual_ratio": ratio,
        "is_bubbled": is_bubbled,
        "chargeable_weight_kg": rounded,
    }


def quote_crossborder(params: dict) -> dict:
    """计算跨境直邮正向定价，金额主币种为 MXN，同时返回 RMB 参考值。"""
    quantity = int(params["quantity"])
    rate = float(params["mxn_per_rmb"])
    unit_cost_mxn = (float(params["product_cost_rmb"]) + float(params["domestic_extra_cost_rmb"])) * rate
    total_weight = quantity * float(params["unit_chargeable_weight_kg"])
    shipping = shipping_cost_mxn(total_weight)
    new_customer = float(params["new_customer_discount_pct"]) / 100
    target_margin = float(params["target_net_margin_pct"]) / 100
    affiliate_rate = float(params["affiliate_commission_pct"]) / 100
    ad_rate = float(params["advertising_pct"]) / 100
    denominator = 1 - 0.1597 * (1 - new_customer) - 0.06 - 0.08 - affiliate_rate * (1 - new_customer) - target_margin - ad_rate
    if denominator <= 0:
        raise ValueError("费用率与目标利润率之和过高，无法形成有效售价")
    sale_price = (quantity * unit_cost_mxn + shipping) / denominator
    if sale_price > 1000:
        sale_price += 60
    import_tax = ((sale_price - 4.5 * 17.66) * (1 - new_customer) / 1.335 * 0.335)
    platform_commission = sale_price * 0.06
    sfp_fee = min(sale_price * 0.08, quantity * 40)
    affiliate_fee = sale_price * (1 - new_customer) * affiliate_rate
    advertising_fee = sale_price * ad_rate
    per_item_fee = quantity * 6
    product_cost = quantity * unit_cost_mxn
    fixed_cost = product_cost + shipping + per_item_fee
    gross_profit = sale_price - fixed_cost
    variable_fees = import_tax + platform_commission + sfp_fee + affiliate_fee + advertising_fee
    net_profit = gross_profit - variable_fees
    discount = float(params["merchant_discount_pct"]) / 100
    list_price = sale_price / (1 - discount - new_customer)
    buyer_shipping = float(params["buyer_shipping_paid_per_item_mxn"])
    return {
        "currency": "MXN",
        "exchange_rate_mxn_per_rmb": rate,
        "unit_product_cost_mxn": unit_cost_mxn,
        "total_chargeable_weight_kg": total_weight,
        "recommended_sale_price_mxn": sale_price,
        "recommended_list_price_mxn": list_price,
        "recommended_unit_list_price_mxn": list_price / quantity - buyer_shipping * 2,
        "fixed_cost_mxn": fixed_cost,
        "gross_profit_mxn": gross_profit,
        "gross_margin_pct": gross_profit / sale_price * 100,
        "variable_selling_fees_mxn": variable_fees,
        "net_profit_mxn": net_profit,
        "net_margin_pct": net_profit / sale_price * 100,
        "cost_breakdown_mxn": {
            "product_cost": product_cost,
            "crossborder_shipping": shipping,
            "per_item_transaction_fee": per_item_fee,
            "import_tax": import_tax,
            "platform_commission": platform_commission,
            "sfp_fee": sfp_fee,
            "affiliate_fee": affiliate_fee,
            "advertising_fee": advertising_fee,
        },
        "rmb_reference": {
            "fixed_cost": fixed_cost / rate,
            "gross_profit": gross_profit / rate,
            "variable_selling_fees": variable_fees / rate,
            "net_profit": net_profit / rate,
            "sale_price": sale_price / rate,
            "list_price": list_price / rate,
        },
    }


def reverse_cost(params: dict) -> dict:
    """已知整单折后售价，反推能达到目标净利率的单件采购成本。"""
    sale = float(params["sale_price_mxn"])
    quantity = int(params["quantity"])
    rate = float(params["mxn_per_rmb"])
    new_customer = float(params["new_customer_discount_pct"]) / 100
    target_margin = float(params["target_net_margin_pct"]) / 100
    affiliate_rate = float(params["affiliate_commission_pct"]) / 100
    ad_rate = float(params["advertising_pct"]) / 100
    shipping = shipping_cost_mxn(quantity * float(params["unit_chargeable_weight_kg"]))
    import_tax = ((sale - 4.5 * 17.66) * (1 - new_customer) / 1.335 * 0.335)
    commission, sfp = sale * 0.06, min(sale * 0.08, quantity * 40)
    affiliate, ads, transaction = sale * (1 - new_customer) * affiliate_rate, sale * ad_rate, quantity * 6
    target_profit = sale * target_margin
    max_total_cost = sale - shipping - import_tax - commission - sfp - affiliate - ads - transaction - target_profit
    discount = float(params["merchant_discount_pct"]) / 100
    return {
        "currency": "MXN",
        "max_unit_product_cost_mxn": max_total_cost / quantity,
        "max_unit_product_cost_rmb": max_total_cost / quantity / rate,
        "total_chargeable_weight_kg": quantity * float(params["unit_chargeable_weight_kg"]),
        "recommended_list_price_mxn": sale / (1 - discount - new_customer),
        "target_net_profit_mxn": target_profit,
        "cost_breakdown_mxn": {"crossborder_shipping": shipping, "import_tax": import_tax, "platform_commission": commission, "sfp_fee": sfp, "affiliate_fee": affiliate, "advertising_fee": ads, "per_item_transaction_fee": transaction},
    }
