# 商品分类树接口

- **接口地址**：`GET https://echotik.live/api/v1/data/products/product-category`
- **接口说明**：获取商品类目树，返回三级分类结构（一级大类 → 二级类目 → 三级类目）。用于商品库/榜单接口中 `product_categories` 参数的取值来源，以及商品 `category` / `categories` 字段的映射对照。

## 请求参数

无 Query 参数，直接 GET 请求即可。

## 响应结构

```json
{
  "code": 0,
  "msg": "ok",
  "data": [ /* 类目节点数组 */ ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| code | int | 状态码，0 表示成功 |
| msg | string | 状态信息 |
| data | array | 类目节点数组，第一个固定为「全部」，最后一个固定为「其他」 |

> 注意：该接口无分页（无 meta 字段），一次返回整棵类目树。

## data 类目节点字段

| 字段 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| value | string | 类目 ID，作为 `product_categories` 参数值使用；「全部」为空字符串 `""`，「其他」为 `"0"` | `"601450"` |
| label | string | 类目中文名称 | `"美妆个护"` |
| name_slug | string | 类目英文 slug，用于 SEO/链接 | `"beauty-personal-care"` |
| children | array | 子类目数组，节点结构相同；叶子节点无此字段 | |

## 层级说明

- 树最多 **3 层**：一级类目（31 个）→ 二级类目 → 三级类目（叶子节点无 `children` 字段）。
- 全量类目树约 2500+ 个节点，一次返回。
- 结构示例：

```json
{
    "value": "601450",
    "label": "美妆个护",
    "name_slug": "beauty-personal-care",
    "children": [
        {
            "value": "849672",
            "label": "鼻子口腔护理",
            "name_slug": "nasal-oral-care",
            "children": [
                {
                    "value": "875400",
                    "label": "鼻部清洁用品",
                    "name_slug": "nasal-cleaning"
                }
            ]
        }
    ]
}
```

## 一级类目清单（value / label）

| value | label | value | label |
| --- | --- | --- | --- |
| `` | 全部 | 602284 | 母婴用品 |
| 601450 | 美妆个护 | 600024 | 厨房用品 |
| 601152 | 女装与女士内衣 | 603014 | 运动与户外 |
| 824328 | 男装与男士内衣 | 700437 | 食品饮料 |
| 600001 | 居家日用 | 601755 | 电脑办公 |
| 605248 | 时尚配件 | 604206 | 玩具和爱好 |
| 601739 | 手机与数码 | 802184 | 儿童时尚 |
| 601303 | 穆斯林时尚 | 605196 | 汽车与摩托车 |
| 824584 | 箱包 | 602118 | 宠物用品 |
| 601352 | 鞋靴 | 600942 | 家电 |
| 600154 | 家纺布艺 | 604968 | 家装建材 |
| 604579 | 五金工具 | 801928 | 图书&杂志&音频 |
| 700645 | 保健 | 953224 | 珠宝与衍生品 |
| 604453 | 家具 | 951432 | 收藏品 |
| 834312 | 虚拟商品 | 856720 | 二手 |
| 0 | 其他 | | |

## 与其他接口的联动

- 商品库列表（[products.md](products.md)）、热销榜（[top-sold.md](top-sold.md)）、热推榜（[hot-sell.md](hot-sell.md)）、新品榜（[news-burst.md](news-burst.md)）的 `product_categories` 参数值即本接口的 `value`（类目 ID），多个用逗号分隔，空字符串表示全部。
- 商品对象中的 `category`（末级/一级类目名）与 `categories`（类目路径）对应本树中的 `label`；商品 slug 前缀与 `name_slug` 对应。
