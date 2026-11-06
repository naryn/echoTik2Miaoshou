# FastMoss 榜单接口文档（总览）

> 本文档由 `docs/fastmoss_interface/*.md` 抓包样本（1 条真实请求 URL + 1 份真实响应 JSON）整理而成。
> FastMoss 未公开接口文档，字段含义基于样本推断，标注「推断」的条目需以实测为准。

- **域名**：`https://www.fastmoss.com`
- **协议**：HTTPS
- **方法**：全部为 `GET`
- **返回**：`application/json`
- **国家/站点**：所有接口均通过 `region` 指定，样本站点为墨西哥 `MX`

## 接口一览

| 文档 | 接口路径 | 榜单 | 关键参数 |
| --- | --- | --- | --- |
| [newRank.md](newRank.md) | `/api/goods/newProduct` | 新品榜 | `rank_type=11`、`start_date` / `end_date` |
| [saleRank.md](saleRank.md) | `/api/goods/saleRank` | 热销榜（销量榜） | `date_type` / `date_value`、`order=1,2` |
| [popRank.md](popRank.md) | `/api/goods/popRank` | 热推榜（热度榜） | `date_type` / `date_value`、`order=4,2` |
| [videoRank.md](videoRank.md) | `/api/video/hotGoodsVideoGroupByProduct` | 带货视频榜（按商品聚合） | `rank_type=7` |

## 公共请求参数

除各接口独有参数外，以下参数在所有接口中通用：

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| page | int | 是 | 页码，从 1 开始 | `2` |
| pagesize | int | 是 | 每页条数；**实测上限 10**（传 20 返回空列表） | `10` |
| region | string | 是 | 站点国家/地区代码 | `MX` |
| l1_cid | string | 否 | 一级类目 ID；`all` 或省略表示全类目 | `10` |
| order | string | 否 | 排序，格式 `字段编号,方向`；`1,2` = 销量降序，`4,2` = 热度降序（方向 `2` 为降序） | `1,2` |
| _time | string | 是 | 请求时间戳（秒级），签名参数，需随每次请求重新生成 | `1793970668` |
| cnonce | string | 是 | 随机数（8 位数字），签名参数，与 `_time` 配套 | `68847508` |

## 鉴权与风控（重要）

1. **并非公开接口**：FastMoss 依赖登录态 Cookie + 前端生成的请求签名。
   - 签名信息出现在 query 的 `_time` / `cnonce`，以及请求头中的 `_time` / `cnonce` / `fm-sign`（见 [adapter.ts](file:///Users/nanrunchen/github/echoTik/extension/src/modules/fastmoss/adapter.ts)）。
   - 签名无法离线推导，必须在 FastMoss 页面上下文（同源）内发请求，例如由 content script 回放页面已发出的真实请求。
2. **风控拦截**：响应 `code` 为字符串 `MSG_SAFE_0001` 时表示被风控拦截（间歇性，可等待 1.5–3s 重试）。
3. **登录限制**：响应 `code` 为 `MAG_AUTH_xxxx`（如 `MAG_AUTH_3004`）表示需要登录，深翻页时常见；此时可能仍返回部分数据。
4. **签名可跨页复用**：同一份签名通常可用于后续分页，但页面筛选项变化后签名会失效。

## 统一响应结构

```json
{
  "code": 200,
  "msg": "success",
  "data": { /* 各接口不同，见分接口文档 */ },
  "ext": { "is_login": 1 }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| code | int \| string | 成功为数字 `200`；风控为 `MSG_SAFE_0001`；鉴权为 `MAG_AUTH_xxxx` |
| msg | string | 状态信息，成功主要为 `success`（视频榜为 `success!`） |
| data | object | 业务数据，各接口结构不同 |
| ext | object | 附加信息 |
| ext.is_login | int | 是否处于登录态：`1` 已登录，`0` 未登录 |

## 字段通用约定

- **`*_show` 字段**：展示态字符串，已做「万/亿」缩写与货币符号拼接（如 `"MX$112.35万"`、`"1.12万"`），可直接用于 UI 渲染；数值计算请使用去掉 `_show` 的同名字段。
- **数值类型**：`sold_count` / `sale_amount` 等在不同条目可能是 `int` 或 `float`，入库前统一按 `number` 处理。
- **金额**：为当地货币数值（`currency` 给出币种，`MX` 站点为 `MXN`），不带货币符号；展示态字段带 `MX$` 前缀。
- **佣金率**：`commission_rate` 为 `"-"` 表示该商品无佣金数据。
- **时间戳**：`update_at` 为秒级 Unix 时间戳；`update_time` / `dt` 为日期字符串。
- **站点名称**：`region_name` 为对应中文名，`MX` → `"墨西哥"`。
