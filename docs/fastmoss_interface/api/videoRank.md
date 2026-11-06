# 带货视频榜接口（hotGoodsVideoGroupByProduct）

- **接口地址**：`GET https://www.fastmoss.com/api/video/hotGoodsVideoGroupByProduct`
- **接口说明**：获取带货视频榜，按**商品**聚合（`GroupByProduct`）：每个商品附带其下的热销视频列表，用于定位「商品 + 爆款视频 + 达人」组合。
- **实测样本**：`region=MX`、`l1_cid=10`、`rank_type=7`、`order=1,2`、`page=2`，返回 10 个商品 / 共 1112 个。

## 请求参数（Query）

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| rank_type | string | 是 | 视频榜类型枚举，实测带货视频榜为 `7` | `7` |
| page | int | 是 | 页码，从 1 开始 | `2` |
| pagesize | int | 是 | 每页条数，实测上限 10 | `10` |
| order | string | 是 | 排序，`字段编号,方向`；`1,2` = 销量降序 | `1,2` |
| region | string | 是 | 站点国家代码 | `MX` |
| l1_cid | string | 否 | 一级类目 ID，`all` 或省略为全部 | `10` |
| _time | string | 是 | 请求时间戳（秒级），签名参数 | `1793970804` |
| cnonce | string | 是 | 随机数（8 位数字），签名参数 | `38070409` |

> 该接口无 `date_type` / `date_value` / `start_date` 参数，统计日由 `rank_type` 决定的榜单口径给出（响应中体现为 `product_list[].dt`）。

## 响应结构

```json
{
  "code": 200,
  "msg": "success!",
  "data": {
    "result_cnt": 1112,
    "total_cnt": 1112,
    "total": 1112,
    "ext": { "total_cnt": 1112, "is_ok": true, "took": 15, "total_cnt_show": "1112" },
    "product_list": [ /* 商品对象数组 */ ],
    "video_list": null,
    "result_cnt_show": "1112",
    "total_cnt_show": "1112"
  },
  "ext": { "is_login": 1 }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| code | int | `200` 表示成功 |
| msg | string | 状态信息，成功为 `success!`（与其他接口的 `success` 不同） |
| data.result_cnt | int | 本次返回结果总数 |
| data.total_cnt | int | 结果总数 |
| data.total | int | 结果总数（与 `total_cnt` 相同） |
| data.ext | object | 查询元信息，见下表 |
| data.product_list | array | 按商品聚合的榜单数组，单页最多 10 条 |
| data.video_list | null | 视频平铺列表，实测恒为 `null`（视频已内嵌在 `product_list[].video_list`） |
| data.result_cnt_show | string | `result_cnt` 展示态 |
| data.total_cnt_show | string | `total_cnt` 展示态 |
| ext.is_login | int | 是否登录：`1` / `0` |

### data.ext 查询元信息

| 字段 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| total_cnt | int | 结果总数 | `1112` |
| is_ok | bool | 查询是否成功 | `true` |
| took | int | 查询耗时（毫秒） | `15` |
| total_cnt_show | string | 总数展示态 | `"1112"` |

## data.product_list[] 商品字段

| 字段 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| product_id | string | 商品 ID | `"1738189557403191032"` |
| title | string | 商品标题 | `"Decoración Navideña Inflable Esfera De Nieve..."` |
| product_name | string | 商品名称（实测与 `title` 相同） | 同上 |
| cover | string | 商品主图 URL | `"https://s.500fd.com/..."` |
| region | string | 站点代码 | `"MX"` |
| region_name | string | 站点中文名 | `"墨西哥"` |
| currency | string | 币种代码 | `"MXN"` |
| price | string | 售价（含货币前缀，区间用 ` - ` 连接） | `"MX$220.00  - 404.00"` |
| launch_time | string | 商品上架时间，`yyyy-MM-dd HH:mm:ss` | `"2026-10-31 01:29:56"` |
| shop_name | string | 店铺名称 | `"hhuihui1"` |
| rank_type | int | 榜单类型，与请求参数一致（注意此处为数字类型） | `7` |
| sold_count | int | 统计区间内销量 | `204` |
| sold_amount | int \| float | 统计区间内销售额（当地货币） | `39986` |
| digg_count | int | 关联视频总点赞数 | `1087` |
| share_count | int | 关联视频总分享数 | `421` |
| play_count | int | 关联视频总播放量 | `324492` |
| comment_count | int | 关联视频总评论数 | `14` |
| video_count | int | 关联视频数 | `27` |
| dt | string | 统计日期 | `"2026-11-05"` |
| category_name | array\<string\> | 类目名数组 | `["居家日用"]` |
| source | string \| null | 数据来源渠道，可能为 `null` | `null` |
| off_shelves | int | 是否已下架：`1` / `0` | `0` |
| detail_url | string | 商品链接，实测可能为空字符串 | `""` |
| video_list | array | 该商品的热销视频列表，见下表 | |
| sold_count_show | string | 销量展示态 | `"204"` |
| sold_amount_show | string | 销售额展示态 | `"MX$3.99万"` |
| digg_count_show | string | 点赞数展示态 | `"1087"` |
| share_count_show | string | 分享数展示态 | `"421"` |
| play_count_show | string | 播放量展示态 | `"32.44万"` |
| comment_count_show | string | 评论数展示态 | `"14"` |
| video_count_show | string | 视频数展示态 | `"27"` |

> `product_list` 不返回 `shop_info`（仅 `shop_name`）；`category_name` 只有一级类目，无 `all_category_name`。

## data.product_list[].video_list[] 视频字段

| 字段 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| video_id | string | 视频 ID | `"7702400919534652693"` |
| is_ad | int | 是否广告视频：`1` / `0` | `1` |
| video_desc | string | 视频文案（含话题标签） | `"#tiktok #tiktokshop #fyp ..."` |
| cover | string | 视频封面 URL | `"https://s.500fd.com/tt_video/..."` |
| play_count | int | 播放量 | `266300` |
| digg_count | int | 点赞数 | `694` |
| comment_count | int | 评论数 | `9` |
| share_count | int | 分享数 | `312` |
| sold_count | int | 该视频带来的销量 | `161` |
| author_uid | string | 达人 UID | `"7600289453224428551"` |
| author_avatar | string | 达人头像 URL | `"https://s.500fd.com/tt_author/..."` |
| author_nickname | string | 达人昵称 | `"ximena66981"` |
| author_unique_id | string | 达人唯一 ID（TikTok 账号名） | `"ximena66981"` |
| play_count_show | string | 播放量展示态 | `"26.63万"` |
| digg_count_show | string | 点赞数展示态 | `"694"` |
| comment_count_show | string | 评论数展示态 | `"9"` |
| share_count_show | string | 分享数展示态 | `"312"` |
| sold_count_show | string | 销量展示态 | `"161"` |

## 备注

- 该接口与商品榜单（`saleRank` / `popRank` / `newProduct`）的响应字段差异较大：无 `shop_info`、无 `total_sold_count` 等累计指标，但多了视频维度指标。
- 商品维度指标（`play_count` / `digg_count` / `sold_count` 等）为**该商品关联视频的汇总值**，与单个 `video_list[]` 条目不是一一对应关系。
