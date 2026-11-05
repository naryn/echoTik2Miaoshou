# EchoTik 接口映射文档（interface/*.md → 代码）

> Phase 0 产物。来源：`docs/interface/` 下 5 份接口文档与 `docs/examples/` 真实响应示例。
> 所有适配器实现（`extension/src/modules/echotik/`）必须与本文档一致；文档未覆盖的能力标记「待验证」，不得伪造。

## 1. 接口总览

| 适配器能力 | 接口 | 方法 | 路径 | 文档 |
|---|---|---|---|---|
| 类目树 | product-category | GET | `https://echotik.live/api/v1/data/products/product-category` | product-category.md |
| 热销榜 | top-sold | GET | `https://echotik.live/api/v1/data/products/leaderboard/top-sold` | top-sold.md |
| 热推榜 | hot-sell | GET | `https://echotik.live/api/v1/data/products/leaderboard/hot-sell` | hot-sell.md |
| 新品榜 | news-burst | GET | `https://echotik.live/api/v1/data/products/leaderboard/news-burst` | news-burst.md |
| 商品库 | products | GET | `https://echotik.live/api/v1/data/products` | products.md |

统一响应壳：`{ code: 0, msg: "ok", data: [...], meta: {...} }`；`code !== 0` 视为业务错误。
分页 `meta`：`current_page / per_page / last_page / total / from / to`（商品库与榜单接口一致，类 Laravel 分页）。

## 2. RankingQuery → 请求参数映射

| RankingQuery 字段 | top-sold / hot-sell / news-burst | products（商品库） |
|---|---|---|
| `rankingType` (DAILY/WEEKLY/MONTHLY) | `time_type=daily/weekly/monthly`（小写） | 无；用 `dateRange`（天）近似统计周期 |
| `periodStart`（榜单日期） | `time_range=yyyyMMdd` | — |
| `categoryId`（类目树 `value`，多选逗号分隔，空=全部） | `product_categories` | `product_categories` |
| `sortBy` | `order`（如 `sale_cnt`、`total_gmv_amt`） | `order`（如 `total_sale_nd_cnt`、`total_sale_gmv_nd_amt`）+ `sort=asc/desc` |
| 分页 | `page`（从 1）+ `per_page` | `page` + `per_page` |
| `region` | ❗ 文档未提供站点切换参数（响应内 `region` 字段标识商品站点），站点选择依赖 EchoTik 页面会话上下文 — **待验证** | 同左 |
| `rankingVariant`（热销/热推/新品） | 由接口路径区分：`top-sold` / `hot-sell` / `news-burst` | — |
| `startRank` / `limit` | 客户端侧实现：按 `per_page` 翻页，截取 `[startRank, startRank+limit)` | 同左 |

## 3. 响应字段 → Product 归一化映射

| 归一化字段 | 榜单接口（top-sold/hot-sell/news-burst） | 商品库 products |
|---|---|---|
| `external_product_id` | `product_id`（字符串，保持字符串防精度丢失） | `product_id` |
| `title` | `product_name`（译文 `product_trans1/2` 存入 raw_excerpt） | `product_name` / `product_title` |
| `image_url` | `cover_url` | `cover_url` |
| `region` | `region`（字符串，如 `"US"`） | `region.id`（对象取 id） |
| `shop_id` / `shop_name` | `seller.seller_id` / `seller.seller_name` | `seller.seller_id` / `seller.seller_name` |
| `category` 路径 | `category`（一级名）+ `categories`（数组） | `category`（末级名）+ `categories`（`/` 分隔字符串） |
| `rank_position` | 由分页推导：`(page-1)*per_page + index + 1` | 不适用（商品库无榜排名） |
| `sales`（当期） | `sale_cnt`（解析"万"单位为数值，原文保留） | `total_sale_nd_cnt` |
| `gmv`（当期） | `total_gmv_amt`（解析 `$` 与"万"） | `total_sale_gmv_nd_amt` |
| 价格 | `real_price / avg_price / min_price / max_price` | 同左 |
| 其它指标 | `influencers_count / total_video_cnt / total_live_cnt / review_count / commission / product_rating / conversion_rate` → `metrics_json` | 同左 + `total_sale_cnt / total_sale_gmv_amt` 等 |
| `raw_excerpt` | 原始条目精简版（剔除 skus/sale_props 大对象，完整对象保留在 metrics_json 可选） | 同左 |

## 4. 单位解析规则

- `"4.13万"` → `41300`；`"$82.95万"` → `829500`（美元）；`"3.29万"` → `32900`；纯数字字符串直接 `Number()`。
- 空串、`""` 视为缺失（`undefined`），不置 0。
- 原文一律保留在 `metrics_json`，解析数值仅用于排序/筛选展示。

## 5. 翻页终止条件（适配器实现）

1. 已收集条数 ≥ `limit`；
2. `meta.current_page >= meta.last_page`；
3. 当前页 `data` 为空数组；
4. 连续两页返回完全相同的首个 `product_id`（重复页保护）；
5. 触发任一条件即结束；用户取消时保留已抓数据并标记快照 `PARTIAL`。

## 6. 筛选条件支持矩阵（UI 表单配置驱动依据）

| 筛选项 | 支持情况 | 说明 |
|---|---|---|
| 国家/站点 | ⚠️ 待验证 | 文档无站点参数；先以页面会话为准，UI 展示但不承诺接口级过滤 |
| 一/二/三级分类 | ✅ | `product_categories` 取类目树 `value`，多选逗号分隔，空=全部 |
| 榜单类型（日/周/月） | ✅ | `time_type=daily/weekly/monthly` |
| 榜单变体（热销/热推/新品） | ✅ | 三个接口路径 |
| 榜单日期 | ✅ | `time_range=yyyyMMdd`；周/月榜的真实统计周期以响应为准（**待验证**：响应未显式返回周期，需 PoC 确认） |
| 排序维度 | ✅ 部分 | `order` 已证实值：`sale_cnt`、`total_gmv_amt`、`total_sale_gmv_7d_amt`、`total_sale_nd_cnt`、`total_sale_gmv_nd_amt`；其余隐藏 |
| 排名范围/数量 | 客户端实现 | 接口无 rank 参数，翻页截取 |

## 7. 待验证清单（PoC-A）

- [ ] 接口是否要求登录 Cookie / CSRF token / 签名（文档未说明，需真实页面实测；MAIN world 桥方案已为此预留）
- [ ] 站点（region）切换是否通过页面上下文而非 query 参数
- [ ] 周/月榜 `time_range` 的取值规则（周一起始日？月份 `yyyyMM`？）
- [ ] 速率限制阈值与 401/403/429 响应形态
- [ ] `per_page` 上限（示例用到 50）
