# 商品库列表接口

- **接口地址**：`GET https://echotik.live/api/v1/data/products`
- **接口说明**：商品库商品列表查询，支持按销量/GMV/达人视频数等条件筛选与排序，返回商品列表与分页信息。

## 请求参数（Query）

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| page | int | 是 | 页码，从 1 开始 | `1` |
| per_page | int | 是 | 每页数量 | `50` |
| dateRange | int | 否 | 统计时间范围（天），如 `7` / `30` | `7` |
| commission_rate | string | 否 | 佣金比例过滤，为空表示全部 | `` |
| related_influencers | string | 否 | 关联达人数过滤 | `` |
| videos_count | string | 否 | 视频数过滤 | `` |
| views_count | string | 否 | 播放量过滤 | `` |
| order | string | 否 | 排序字段，如 `total_sale_nd_cnt`、`total_sale_gmv_nd_amt` | `total_sale_nd_cnt` |
| sort | string | 否 | 排序方向，`asc` / `desc` | `desc` |
| product_categories | string | 否 | 商品类目过滤（推断支持，同榜单接口），取类目树接口的 `value`（类目 ID），多个用逗号分隔，为空表示全部，取值见 [product-category.md](product-category.md) | `` |

## 响应结构

```json
{
  "code": 0,
  "msg": "ok",
  "data": [ /* 商品对象数组 */ ],
  "meta": { /* 分页信息 */ }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| code | int | 状态码，0 表示成功 |
| msg | string | 状态信息 |
| data | array | 商品对象数组 |
| meta | object | 分页信息，见文末「分页结构 meta」 |

## data 商品对象字段

| 字段 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| product_id | string | 商品 ID | `"1732052189676081387"` |
| product_name | string | 商品名称（英文标题） | |
| product_trans1 | string | 商品名称译文 1（中文全译），可能为空 | |
| product_trans2 | string | 商品名称译文 2（中文简译），可能为空 | |
| highlight | string | 搜索高亮片段，非搜索场景为空 | `""` |
| product_title | string | 商品完整标题 | |
| product_title_brief | string | 商品标题简版（截断） | `"[medicube] Smooth & Clear Body Care Set..."` |
| product_name_slug | string | 商品名称 SEO slug | |
| avg_price | string | 平均售价（美元） | `"$93"` |
| min_price | string | 最低售价（美元） | `"$31"` |
| max_price | string | 最高售价（美元） | `"$202.8"` |
| avg_price_fz | string | 平均售价（人民币 ¥） | `"¥620.4"` |
| min_price_fz | string | 最低售价（人民币 ¥） | |
| max_price_fz | string | 最高售价（人民币 ¥） | |
| shipping_price | string | 运费，可能为空 | `""` |
| real_price | string | 实际售价（美元），区间形式 | `"$87.10 - 202.80"` |
| original_price | string | 划线价/原价（美元），区间形式 | `"$87.10 - 202.80"` |
| cover_url | string | 商品主图 URL | |
| category | string | 末级类目名称，对应类目树叶子节点 `label`（见 [product-category.md](product-category.md)） | `"身体护理套装"` |
| categories | string | 类目完整路径（`/` 分隔的字符串，一级/二级/三级），对应类目树各级 `label` | `"美妆个护/洗浴与身体护理/身体护理套装"` |
| seller | object | 店铺信息，结构同热销榜「seller」 | |
| region | object | 站点/地区对象，见「region 结构」 | `{"id":"US","name":"美国","key":"us"}` |
| commission | string | 佣金比例，可能为空 | `"15%"` |
| product_rating | string | 商品评分 | `"4.6"` |
| lives_sales | int | 直播带货销量 | `8231` |
| videos_sales | string | 视频带货销量（可能带单位） | `"27.66万"` |
| influencers_count | string | 关联达人数量 | `"1.11万"` |
| videos_count | string | 关联视频数量 | `"2.92万"` |
| lives_count | int | 关联直播数量 | `660` |
| view_count | string | 播放量（可能带单位） | `"5.55亿"` |
| total_sale_nd_cnt | string | 近 N 天销量（N 由 dateRange 决定） | `"4.13万"` |
| total_sale_7d_cnt | string | 近 7 天销量 | `"4.13万"` |
| total_sale_30d_cnt | string | 近 30 天销量 | `"20.1万"` |
| total_sale_cnt | string | 总销量 | `"59.47万"` |
| total_ifl_cnt | string | 总关联达人数 | `"1.11万"` |
| total_video_count | string | 总关联视频数 | `"2.92万"` |
| total_live_count | int | 总关联直播数 | `660` |
| total_sale_gmv_nd_amt | string | 近 N 天 GMV（美元） | `"$350.75万"` |
| total_sale_gmv_7d_amt | string | 近 7 天 GMV（美元） | |
| total_sale_gmv_30d_amt | string | 近 30 天 GMV（美元） | |
| total_sale_gmv_amt | string | 总 GMV（美元） | `"$4784.98万"` |
| total_sale_gmv_nd_amt_fz | string | 近 N 天 GMV（人民币 ¥） | |
| total_sale_gmv_7d_amt_fz | string | 近 7 天 GMV（人民币 ¥） | |
| total_sale_gmv_30d_amt_fz | string | 近 30 天 GMV（人民币 ¥） | |
| total_sale_gmv_amt_fz | string | 总 GMV（人民币 ¥） | |
| review_count | string | 评论数 | `"3.29万"` |
| sale_props | array | 销售属性（规格）列表，结构同热销榜「sale_props」 | |
| skus | object | SKU 映射，key 为销售属性值 ID（多个用 `_` 拼接），结构同热销榜「skus」 | |
| specs_count | int | 规格数量 | `2` |
| sales_trending | array | 销量趋势数据（可能为空数组） | `[]` |
| seller_type | object | 卖家类型，枚举对象 `{"id","name","key"}` | `{"id":1,"name":"本地","key":"local"}` |
| is_s_shop | int | 是否 S 级店铺，0/1 | `0` |
| shop_type | int | 店铺类型（1=本地店 等） | `1` |
| is_free_shipping | int | 是否包邮，0/1 | `1` |
| off | int | 折扣力度标记（0 表示无） | `0` |
| is_hot | int | 是否热卖标记，0/1 | `0` |
| is_mall_recommended | int | 是否商城推荐，0/1 | `0` |
| collect_status | object | 收藏状态，枚举对象 `{"id","name","key"}` | `{"id":0,"name":"Off","key":"off"}` |
| group_id | string | 分组 ID（0 表示未分组） | `"0"` |
| is_delete | int | 是否已删除，0/1 | `0` |
| is_latest | int | 是否最新商品，0/1 | |

## 嵌套结构

### region 结构

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 地区代码，如 `"US"` |
| name | string | 地区中文名，如 `"美国"` |
| key | string | 地区小写 key，如 `"us"` |

> seller / sale_props / skus / real_price / 枚举对象结构与 [top-sold.md](top-sold.md) 完全一致，不再重复列出。

## 分页结构 meta

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| current_page | int | 当前页码 |
| from | int | 本页起始序号 |
| last_page | int | 最后一页页码 |
| links | array | 分页链接列表，元素含 `url`(string\|null)、`label`(string)、`active`(bool) |
| path | string | 接口路径（内网地址） |
| per_page | int | 每页数量 |
| to | int | 本页结束序号 |
| total | int | 总记录数 |
