# 新品榜（爆款新品）接口

- **接口地址**：`GET https://echotik.live/api/v1/data/products/leaderboard/news-burst`
- **接口说明**：获取新品榜（近期上架且销售表现突出的商品榜单），返回商品列表与分页信息。

## 请求参数（Query）

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| time_type | string | 是 | 时间粒度，如 `daily` / `weekly` / `monthly` | `daily` |
| time_range | string | 是 | 日期，格式 `yyyyMMdd` | `20261027` |
| page | int | 是 | 页码，从 1 开始 | `1` |
| per_page | int | 是 | 每页数量 | `10` |
| product_categories | string | 否 | 商品类目过滤，取类目树接口的 `value`（类目 ID），多个用逗号分隔，为空表示全部，取值见 [product-category.md](product-category.md) | `` |
| order | string | 否 | 排序字段，如 `total_sale_gmv_7d_amt` | `total_sale_gmv_7d_amt` |

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
| product_id | string | 商品 ID | `"1732773235851760558"` |
| product_name | string | 商品名称（英文标题） | |
| product_name_slug | string | 商品名称 SEO slug | |
| product_trans1 | string | 商品名称译文 1（中文全译），可能为空 | |
| product_trans2 | string | 商品名称译文 2（中文简译），可能为空 | |
| cover_url | string | 商品主图 URL | |
| category | string | 一级类目名称，对应类目树一级 `label`（见 [product-category.md](product-category.md)） | `"珠宝与衍生品"` |
| categories | array<string> | 类目路径（数组形式），对应类目树各级 `label` | `["珠宝与衍生品"]` |
| region | string | 站点/地区代码 | `"US"` |
| real_price | string | 实际售价（美元），区间形式 | `"$587.00"` |
| avg_price | string | 平均售价（美元） | `"$587"` |
| min_price | string | 最低售价（美元） | |
| max_price | string | 最高售价（美元） | |
| avg_price_fz | string | 平均售价（人民币 ¥） | |
| min_price_fz | string | 最低售价（人民币 ¥） | |
| max_price_fz | string | 最高售价（人民币 ¥） | |
| sale_props | array | 销售属性（规格）列表，结构同热销榜「sale_props」 | |
| skus | object | SKU 映射，key 为销售属性值 ID（多个用 `_` 拼接），结构同热销榜「skus」 | |
| specs_count | int | 规格数量 | `1` |
| seller | object | 店铺信息，结构同热销榜「seller」 | |
| commission | string | 佣金比例，可能为空 | `""` |
| product_rating | string | 商品评分 | `"0.0"` |
| review_count | string | 评论数 | `"0"` |
| influencers_count | string | 关联达人数量 | `"0"` |
| total_video_cnt | string | 关联视频总数 | `"0"` |
| total_video_sale_cnt | string | 视频带货销量 | `"0"` |
| total_live_cnt | string | 关联直播总数 | `"0"` |
| total_sale_cnt | string | 总销量 | `"3452"` |
| total_sale_7d_cnt | string | 近 7 天销量 | |
| total_sale_1d_cnt | string | 近 1 天销量 | |
| total_sale_gmv_amt | string | 总 GMV（美元） | |
| total_sale_gmv_7d_amt | string | 近 7 天 GMV（美元） | |
| total_sale_gmv_1d_amt | string | 近 1 天 GMV（美元） | |
| total_sale_gmv_amt_fz | string | 总 GMV（人民币 ¥） | |
| total_sale_gmv_7d_amt_fz | string | 近 7 天 GMV（人民币 ¥） | |
| total_sale_gmv_1d_amt_fz | string | 近 1 天 GMV（人民币 ¥） | |
| collect_status | object | 收藏状态，枚举对象 `{"id","name","key"}` | `{"id":0,"name":"Off","key":"off"}` |
| seller_type | object | 卖家类型，枚举对象 `{"id","name","key"}` | `{"id":1,"name":"本地","key":"local"}` |
| is_s_shop | int | 是否 S 级店铺，0/1 | `0` |
| is_mall_recommended | int | 是否商城推荐，0/1 | `0` |

> 嵌套结构（seller / sale_props / skus / real_price / 枚举对象）与 [top-sold.md](top-sold.md) 完全一致，不再重复列出。

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
