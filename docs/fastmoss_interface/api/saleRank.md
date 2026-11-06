# 热销榜接口（saleRank）

- **接口地址**：`GET https://www.fastmoss.com/api/goods/saleRank`
- **接口说明**：获取 TikTok Shop 热销榜（按销量降序），支持日/周/月周期与类目筛选。
- **实测样本**：`region=MX`、`l1_cid=10`、`date_type=1`、`date_value=2026-11-05`、`order=1,2`、`page=1`，返回 10 条 / 共 500 条。

## 请求参数（Query）

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| page | int | 是 | 页码，从 1 开始 | `1` |
| pagesize | int | 是 | 每页条数，实测上限 10 | `10` |
| order | string | 是 | 排序，`字段编号,方向`；`1,2` = 销量降序 | `1,2` |
| date_type | int | 是 | 周期类型：`1` 日榜 / `2` 周榜 / `3` 月榜 | `1` |
| date_value | string | 是 | 周期值：日/周榜 `yyyy-MM-dd`，月榜 `yyyy-MM` | `2026-11-05` |
| region | string | 是 | 站点国家代码 | `MX` |
| l1_cid | string | 否 | 一级类目 ID，`all` 或省略为全部 | `10` |
| _time | string | 是 | 请求时间戳（秒级），签名参数 | `1793970527` |
| cnonce | string | 是 | 随机数（8 位数字），签名参数 | `35369766` |

## 响应结构

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "rank_list": [ /* 商品对象数组 */ ],
    "total_count": 500,
    "update_at": 1793903838,
    "total_count_show": "500"
  },
  "ext": { "is_login": 1 }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| code | int | `200` 表示成功 |
| msg | string | 状态信息 |
| data.rank_list | array | 榜单商品对象数组，单页最多 10 条 |
| data.total_count | int | 榜单商品总数，商品榜上限为 500 |
| data.update_at | int | 数据更新时间（秒级 Unix 时间戳） |
| data.total_count_show | string | 总数的展示态文本 |
| ext.is_login | int | 是否登录：`1` / `0` |

## data.rank_list[] 商品字段

| 字段 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| product_id | string | 商品 ID | `"1736907918395213354"` |
| sold_count | int | 统计区间内销量 | `1580` |
| sale_amount | int \| float | 统计区间内销售额（当地货币） | `115024` |
| yd_sold_count | int | 昨日销量（日榜时与 `sold_count` 相等，推断） | `1580` |
| yd_sale_amount | int \| float | 昨日销售额（推断同上） | `115024` |
| total_sold_count | int | 累计销量 | `11582` |
| total_sale_amount | int \| float | 累计销售额（当地货币） | `871527.77` |
| sold_count_inc_rate | string | 销量环比增速 | `"4.57%"` |
| aweme_count | int | 带货视频数 | `26` |
| live_count | int | 带货直播场次 | `163` |
| author_count | int | 带货达人数 | `112` |
| total_author_count | int | 累计带货达人数 | `723` |
| is_sshop | string | 是否品牌旗舰店：`"1"` / `"0"` | `"0"` |
| off_shelves | int | 是否已下架：`1` / `0` | `0` |
| is_collect | int | 是否已收藏：`1` / `0` | `0` |
| launch_time | string | 商品上架时间，`yyyy-MM-dd HH:mm:ss` | `"2026-08-07 07:31:59"` |
| ctime | string | 商品创建时间，实测与 `launch_time` 相同 | `"2026-08-07 07:31:59"` |
| title | string | 商品标题（当地语言） | `"Serie de Luces LED de Navidad..."` |
| cover | string | 主图 URL | `"https://s.500fd.com/..."` |
| region | string | 站点代码 | `"MX"` |
| region_name | string | 站点中文名 | `"墨西哥"` |
| currency | string | 币种代码 | `"MXN"` |
| real_price | string | 实际售价（含货币前缀，价格区间用 ` - ` 连接） | `"MX$65.30  - 839.00"` |
| commission_rate | string | 佣金率，`"-"` 表示无数据 | `"-"` |
| commission_rate_show | string | 佣金率展示态 | `"-"` |
| category_name | array\<string\> | 末级类目名数组 | `["节日装饰"]` |
| all_category_name | array\<string\> | 完整类目路径 | `["居家日用","节庆及派对用品","节日装饰"]` |
| detail_url | string | TikTok Shop 商品链接，可直接跳转 | `"https://shop.tiktok.com/view/product/1736907918395213354?region=MX&local=en"` |
| source | string \| null | 数据来源渠道，可能为 `null` | `"TikTok Shop"` |
| shop_info | object | 店铺信息，见下表 | |
| sold_count_show | string | 销量展示态 | `"1580"` |
| sale_amount_show | string | 区间销售额展示态 | `"MX$11.50万"` |
| yd_sold_count_show | string | 昨日销量展示态 | `"1580"` |
| yd_sale_amount_show | string | 昨日销售额展示态 | `"MX$11.50万"` |
| total_sold_count_show | string | 累计销量展示态 | `"1.15万"` |
| total_sale_amount_show | string | 累计销售额展示态 | `"MX$87.15万"` |
| sold_count_inc_rate_show | string | 环比增速展示态 | `"4.57%"` |
| aweme_count_show | string | 视频数展示态 | `"26"` |
| live_count_show | string | 直播场次展示态 | `"163"` |
| author_count_show | string | 达人数展示态 | `"112"` |
| total_author_count_show | string | 累计达人数展示态 | `"723"` |

## shop_info 店铺字段

| 字段 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| seller_id | string | 店铺 ID | `"7494279564130158122"` |
| name | string | 店铺名称 | `"Lux Belleza MX"` |
| avatar | string | 店铺头像 URL | `"https://s.500fd.com/tt_shop/..."` |
| sold_count | int | 店铺累计销量 | `87092` |
| is_sshop | string | 是否品牌旗舰店 | `"0"` |
| sold_count_show | string | 店铺销量展示态 | `"8.70万"` |

> 注意：saleRank 的 `shop_info` 不返回 `region` / `region_name` / `avatar_oss`，与 [newProduct](newRank.md) 的结构不同。

## 备注

- `saleRank` 与 [`popRank`](popRank.md) 请求参数与响应字段完全一致，仅榜单口径（排序）不同，可通过改写路径 + `order` 互相切换。
- 榜单总数最多 500 条，`total_count` 恒显示 500 时表示已到快照上限，而非真实全量。
