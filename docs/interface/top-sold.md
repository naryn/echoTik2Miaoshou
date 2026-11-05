# 热销榜列表接口

- **接口地址**：`GET https://echotik.live/api/v1/data/products/leaderboard/top-sold`
- **接口说明**：获取商品热销榜（按销量/GMV 排序的榜单数据），返回商品列表与分页信息。

## 请求参数（Query）

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| time_type | string | 是 | 时间粒度，如 `daily` / `weekly` / `monthly` | `daily` |
| time_range | string | 是 | 日期，格式 `yyyyMMdd` | `20261103` |
| page | int | 是 | 页码，从 1 开始 | `1` |
| per_page | int | 是 | 每页数量 | `50` |
| product_categories | string | 否 | 商品类目过滤，取类目树接口的 `value`（类目 ID），多个用逗号分隔，为空表示全部，取值见 [product-category.md](product-category.md) | `` |
| order | string | 否 | 排序字段，如 `sale_cnt`、`total_gmv_amt` | `sale_cnt` |

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
| product_name_slug | string | 商品名称 SEO slug | `"beauty-personal-care-medicube-smooth-clear-body-care-set"` |
| product_trans1 | string | 商品名称译文 1（中文全译），可能为空 | |
| product_trans2 | string | 商品名称译文 2（中文简译），可能为空 | |
| cover_url | string | 商品主图 URL | |
| category | string | 一级类目名称，对应类目树一级 `label`（见 [product-category.md](product-category.md)） | `"美妆个护"` |
| categories | array<string> | 类目路径（数组形式），对应类目树各级 `label` | `["美妆个护"]` |
| region | string | 站点/地区代码 | `"US"` |
| real_price | string | 实际售价（美元），区间形式 | `"$87.10 - 202.80"` |
| avg_price | string | 平均售价（美元） | `"$93"` |
| min_price | string | 最低售价（美元） | `"$31"` |
| max_price | string | 最高售价（美元） | `"$202.8"` |
| avg_price_fz | string | 平均售价（人民币 ¥） | `"¥620.4"` |
| min_price_fz | string | 最低售价（人民币 ¥） | `"¥206.8"` |
| max_price_fz | string | 最高售价（人民币 ¥） | `"¥1352.88"` |
| sale_props | array | 销售属性（规格）列表，见「sale_props 结构」 | |
| skus | object | SKU 映射，key 为销售属性值 ID（多个用 `_` 拼接），见「skus 结构」 | |
| specs_count | int | 规格数量 | `2` |
| seller | object | 店铺信息，见「seller 结构」 | |
| commission | string | 佣金比例，可能为空 | `"15%"` |
| product_rating | string | 商品评分 | `"4.6"` |
| review_count | string | 评论数（可能带“万”等单位） | `"3.24万"` |
| influencers_count | string | 关联达人数量 | |
| total_video_cnt | string | 关联视频总数 | |
| total_live_cnt | string | 关联直播总数 | |
| sale_cnt | string | 当期销量（榜单周期内） | `"8919"` |
| total_sale_cnt | string | 总销量（可能带单位） | `"59.47万"` |
| total_gmv_amt | string | 当期 GMV（美元，可能带单位） | `"$82.95万"` |
| total_sale_gmv_amt | string | 总 GMV（美元） | |
| total_gmv_amt_fz | string | 当期 GMV（人民币 ¥） | |
| total_sale_gmv_amt_fz | string | 总 GMV（人民币 ¥） | |
| conversion_rate | string | 转化率 | `"0%"` |
| collect_status | object | 收藏状态，见「枚举对象结构」 | `{"id":0,"name":"Off","key":"off"}` |
| seller_type | object | 卖家类型，见「枚举对象结构」 | `{"id":1,"name":"本地","key":"local"}` |
| is_s_shop | int | 是否 S 级店铺，0/1 | `0` |
| is_mall_recommended | int | 是否商城推荐，0/1 | `0` |

## 嵌套结构

### seller 结构

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| seller_id | string | 店铺 ID |
| seller_name | string | 店铺名称 |
| cover_url | string | 店铺头像 URL |
| total_sale_cnt | string | 店铺总销量 |
| total_sale_gmv_amt | string | 店铺总 GMV（美元） |
| total_sale_gmv_amt_fz | string | 店铺总 GMV（人民币 ¥） |

### sale_props 结构

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| prop_name | string | 属性名，如 `OPTIONS` / `Color` |
| has_image | bool | 属性值是否带图 |
| prop_id | string | 属性 ID |
| sale_prop_values | array | 属性值列表 |

`sale_prop_values` 元素：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| image | string | 属性值图片 URL，无图时为空字符串 |
| prop_value_id | string | 属性值 ID |
| prop_value | string | 属性值原始文案 |
| property_value_name | string | 属性值展示名 |

### skus 结构

key 为 `sale_prop_value_ids`（多个属性值 ID 用 `_` 拼接），value 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| sku_id | string | SKU ID |
| sale_prop_value_ids | string | 属性值 ID 组合，与外层 key 相同 |
| real_price | object | SKU 价格对象，见下 |
| stock | int | 库存数量 |

`real_price` 对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| symbol_position | int | 货币符号位置，1 表示前置 |
| price_type | int | 价格类型 |
| show_currency_space | bool | 货币符号与金额间是否带空格 |
| sale_price_format | string | 格式化售价，如 `"156.00"` |
| currency_symbol | string | 货币符号，如 `"$"` |
| sale_price_decimal | string | 售价数值字符串，如 `"156"` |
| currency_name | string | 货币名称，如 `"USD"` |
| price_str | string | 价格字符串 |
| price_val | string | 价格数值 |
| currency | string | 货币代码，如 `"USD"` |
| price_format | string | 带符号的价格，如 `"$156"` |

### 枚举对象结构（collect_status / seller_type）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int | 枚举值 ID |
| name | string | 展示名称 |
| key | string | 枚举 key，如 `off` / `local` |

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
