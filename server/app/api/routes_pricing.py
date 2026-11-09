"""无状态的跨境直邮定价 API。"""

from fastapi import APIRouter, HTTPException

from app.api.deps import ok
from app.api.schemas import ChargeableWeightRequest, CrossBorderPricingRequest, ReverseCostRequest
from app.services.pricing_service import chargeable_weight_kg, quote_crossborder, reverse_cost

router = APIRouter(prefix="/v1/pricing", tags=["pricing"])


@router.post("/crossborder/quote")
def crossborder_quote(body: CrossBorderPricingRequest):
    """计算跨境直邮正向定价、固定成本、毛利与净利。"""
    try:
        return ok(quote_crossborder(body.model_dump()))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/crossborder/reverse-cost")
def crossborder_reverse_cost(body: ReverseCostRequest):
    try:
        return ok(reverse_cost(body.model_dump()))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/chargeable-weight")
def chargeable_weight(body: ChargeableWeightRequest):
    try:
        return ok(chargeable_weight_kg(**body.model_dump()))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
