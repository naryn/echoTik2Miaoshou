# 新品榜接口（newProduct）

- **接口地址**：`GET https://www.fastmoss.com/api/goods/newProduct`
- **接口说明**：获取 TikTok Shop 新品榜（指定统计区间内新上架且销售表现靠前的商品）。
- **实测样本**：`region=MX`、`l1_cid=10`（居家日用）、`start_date=end_date=2026-11-03`、`page=2`，返回 10 条 / 共 66 条。

## 请求参数（Query）

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| rank_type | string | 是 | 榜单类型枚举，新品榜固定 `11` | `11` |
| page | int | 是 | 页码，从 1 开始 | `2` |
| pagesize | int | 是 | 每页条数，实测上限 10 | `10` |
| order | string | 是 | 排序，`字段编号,方向`；`1,2` = 销量降序 | `1,2` |
| region | string | 是 | 站点国家代码 | `MX` |
| l1_cid | string | 否 | 一级类目 ID，`all` 或省略为全部 | `10` |
| start_date | string | 是 | 统计起始日期，`yyyy-MM-dd` | `2026-11-03` |
| end_date | string | 是 | 统计结束日期，`yyyy-MM-dd`；日榜时与 `start_date` 相同 | `2026-11-03` |
| _time | string | 是 | 请求时间戳（秒级），签名参数 | `1793970668` |
| cnonce | string | 是 | 随机数（8 位数字），签名参数 | `68847508` |

> 周期换算：周榜 `end_date = start_date + 6 天`，月榜 `end_date = 当月月末`（见 [adapter.ts](file:///Users/nanrunchen/github/echoTik/extension/src/modules/fastmoss/adapter.ts#L106-L124)）。

## 响应结构

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "list": [ /* 商品对象数组 */ ],
    "total": 66,
    "update_time": "2026-11-06"
  },
  "ext": { "is_login": 1 }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| code | int | `200` 表示成功 |
| msg | string | 状态信息 |
| data.list | array | 商品对象数组，单页最多 10 条 |
| data.total | int | 满足条件的商品总数（用于计算总页数） |
| data.update_time | string | 数据更新日期，`yyyy-MM-dd` |
| ext.is_login | int | 是否登录：`1` / `0` |

## data.list[] 商品字段

| 字段 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| dt | string | 统计日期 | `"2026-11-03"` |
| rank_type | string | 榜单类型，与请求参数一致 | `"11"` |
| product_id | string | 商品 ID | `"1738242922462545215"` |
| seller_id | string | 店铺 ID | `"7494281051843233087"` |
| region | string | 站点代码 | `"MX"` |
| category_id | string | 一级类目 ID | `"10"` |
| uid | string \| null | 关联达人 UID，无关联时为 `null` | `"7435119173007950903"` |
| sold_count | int | 统计区间内销量 | `47` |
| sold_count_inc_rate | string | 销量环比增速 | `"0%"` |
| total_sold_count | int | 累计销量 | `47` |
| sale_amount | int \| float | 统计区间内销售额（当地货币） | `5123` |
| total_sale_amount | int \| float | 累计销售额（当地货币） | `5123` |
| commission_rate | string | 佣金率，`"-"` 表示无数据 | `"8.5%"` |
| author_count | int | 统计区间内带货达人数 | `8` |
| total_author_count | int | 累计带货达人数 | `6` |
| aweme_count | int | 统计区间内带货视频数 | `0` |
| total_aweme_count | int | 累计带货视频数 | `0` |
| live_count | int | 统计区间内带货直播场次 | `15` |
| total_live_count | int | 累计带货直播场次 | `15` |
| is_sshop | string | 是否品牌旗舰店：`"1"` / `"0"` | `"0"` |
| is_cross_border | string | 是否跨境商品：`"1"` / `"0"` | `"0"` |
| data_date | string | 数据生成时间，`yyyy-MM-dd HH:mm:ss` | `"2026-11-06 02:33:48"` |
| title | string | 商品标题（当地语言） | 西语标题 |
| title_split | null | 标题分词结果，实测恒为 `null` | `null` |
| is_collect | int | 是否已收藏：`1` / `0` | `0` |
| off_shelves | int | 是否已下架：`1` / `0` | `0` |
| cover | string | 主图 URL | `"https://s.500fd.com/..."` |
| real_price | string | 实际售价（含货币前缀，区间用 ` - ` 连接） | `"MX$109.00"` |
| format_price | int | 格式化价格标记，实测恒为 `0` | `0` |
| original_price | string | 原价，可能为空字符串 | `"MX$229.00"` |
| launch_time | string | 商品上架时间，`yyyy-MM-dd HH:mm:ss` | `"2026-11-03 08:03:16"` |
| shop_info | object | 店铺信息，见下表 | |
| category_name | array\<string\> | 末级类目名数组 | `["居家日用"]` |
| all_category_name | array\<string\> | 完整类目路径（一级 → 末级） | `["居家日用","节庆及派对用品","节日装饰"]` |
| region_name | string | 站点中文名 | `"墨西哥"` |
| sold_count_show | string | 销量的展示态文本 | `"47"` |
| sold_count_inc_rate_show | string | 环比增速展示态 | `"0%"` |
| total_sold_count_show | string | 累计销量展示态 | `"47"` |
| sale_amount_show | string | 区间销售额展示态 | `"MX$5123"` |
| total_sale_amount_show | string | 累计销售额展示态 | `"MX$5123"` |
| author_count_show | string | 达人数展示态 | `"8"` |
| total_author_count_show | string | 累计达人数展示态 | `"6"` |
| aweme_count_show | string | 视频数展示态 | `"0"` |
| total_aweme_count_show | string | 累计视频数展示态 | `"0"` |
| live_count_show | string | 直播场次展示态 | `"15"` |
| total_live_count_show | string | 累计直播场次展示态 | `"15"` |

## shop_info 店铺字段

| 字段 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| seller_id | string | 店铺 ID | `"7494281051843233087"` |
| name | string | 店铺名称 | `"Novedades De Hogar"` |
| avatar_oss | string | 头像 OSS 相对路径（不含域名） | `"tt_shop/9a9dd7..."` |
| sold_count | int | 店铺累计销量 | `7819` |
| region | string | 店铺所在站点 | `"MX"` |
| avatar | string | 头像完整 URL（`https://s.500fd.com/` + `avatar_oss`） | `"https://s.500fd.com/tt_shop/..."` |
| is_sshop | string | 是否品牌旗舰店 | `"0"` |
| sold_count_show | string | 店铺销量展示态 | `"7819"` |
| region_name | string | 站点中文名 | `"墨西哥"` |

## 备注

- 新品榜不返回 `detail_url`，商品链接需由 `product_id` 拼接：`https://shop.tiktok.com/view/product/{product_id}?region={region}&local=en`。
- `sold_count` 与 `total_sold_count` 在商品上架时间落在统计区间内时会相等。
