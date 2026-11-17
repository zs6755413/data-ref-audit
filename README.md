# data-ref-audit

> 拿 JSON 当数据库用的人，没有外键帮你兜底。
>
> 一条工具数据里的 `linkId` 指向 `links` 里的某条记录。哪天那条被删了，工具页不会报错，它只是渲染出一个空白。等你在搜索结果的摘要里看到一个没有名字的条目，才知道数据早就断了。

这个工具就是查这个的。零依赖，一份数据加一份 schema，几秒钟把四类问题列出来。

## 先说它解决什么

小站用 JSON 存数据很常见：一个 `data.json`，几个数组，读进内存就能用。省掉了数据库、省掉了 ORM，也顺手省掉了数据库帮你做的那些约束。

代价要到数据长起来才显现。我这边的情况是：工具档案五百多条，站点链接一千多条，两套数据靠一个 `linkId` 关联。某次改版删了几条重复的链接，工具的 `linkId` 就悬空了。页面上那条工具还在，只是它的「访问入口」变成了空链接。

更早还有一次，同一张卡片上有两个 slug 一模一样，生成 sitemap 的时候出了两个不同 URL 指向同一内容。搜索引擎那边看到的是重复内容，我这边看到的是一切正常。

这类问题的共同点是：**单看每一条数据都是对的，坏在它们之间的关系上。** 跟证书那个坑一样——面板正常、监控正常、浏览器小锁正常，合起来是错的（那次记录在[这里](https://www.kan112.com/post/p_092215f8)）。

所以有了这个工具。

## 查六类问题

| 检查项 | 说明 |
|---|---|
| `missing-required` | 必填字段不存在 |
| `blank-required` | 字段存在，但是空字符串或 `null` |
| `invalid-enum` | 取值不在允许列表里 |
| `duplicate-id` | 同一集合内 id 重复 |
| `duplicate-unique` | 声明为唯一值的字段重复（比较前做规范化） |
| `dangling-ref` | 引用字段指向不存在的目标 |
| `unreferenced` | 目标集合里有条目从来没被引用过 |
| `field-coverage` | 同集合内字段覆盖率不一致 |

前六个是错误，后两个是提醒。

**为什么把「空字符串」和「字段缺失」分开报。** 这两种在代码里的表现完全不一样：字段缺失时 `row.name` 是 `undefined`，空字符串时是 `''`。前者会被 `if (row.name)` 挡住，后者不会——`''` 是 falsy，但如果代码写的是 `if (row.name !== undefined)`，空字符串就漏过去了，页面上显示一个空标题。分两行报，改起来才知道该改哪。

**为什么单独查「没人引用」。** 这是反向的引用孤儿。`links` 里有一条谁都不指向它，可能是残留、可能是分类错了、也可能是工具侧漏了一批。它不会让页面出错，但它会让你以为这个站有 7 个链接可用，实际只有 6 个。

**为什么要报字段覆盖率。** 数据结构漂移是慢慢发生的：新加的字段只有新数据才有，老数据没有。今天写读代码的人知道要兜底，三个月后接手的人不知道。覆盖率这一栏就是把这个隐性债务摆出来。

## 用法

```bash
node bin/audit.js data/sample.json schema.json
node bin/audit.js data/sample.json schema.json --json
node bin/audit.js data/sample.json schema.json --no-orphans
node bin/audit.js data/sample.json schema.json --strict
```

样例数据里我故意埋了五类问题，跑出来是这样：

```text
集合 ──────────────────────────────────────────────────────

集合          条目    问题
tools           10       7
links            7       1

按类型 ────────────────────────────────────────────────────

  引用孤儿           2  dangling-ref
  字段缺失           1  missing-required
  枚举越界           1  invalid-enum
  字段为空           1  blank-required
  id 重复            1  duplicate-id
  唯一值重复         1  duplicate-unique
  无人引用           1  unreferenced

明细 ──────────────────────────────────────────────────────

  tools
    err   t3      name      字段缺失
    err   t5      group     取值不在允许范围内（允许：chat / draw / code / office / video / audio）  值="coding"
    err   t7      name      字段存在但为空
    err   t2      id        id 与第 2 条重复  值="t2"
    err   t4      slug      与第 1 条重复（规范化后比较）  值="doubao"
    err   t6      linkId    指向 links 中不存在的 id  值="l99"
    err   t9      linkId    指向 links 中不存在的 id  值="l98"

  links
    warn  l5      linkId    没有任何条目的 linkId 指向它，可能是孤儿内容  值="l5"

字段覆盖率（部分条目才有） ──────────────────────────────────

  tools.freeQuota               1/10  ██··············    10%
  tools.price                   2/10  ███·············    20%
  tools.name                    8/10  █████████████···    80%
```

退出码：有错误返回 1，只有提醒返回 0（加 `--strict` 时提醒也算失败）。挂在 CI 或提交钩子上就不用记着自己跑。

## schema 怎么写

```json
{
  "collections": {
    "tools": {
      "id": "id",
      "required": ["id", "name", "slug", "group"],
      "unique": ["slug"],
      "enums": {
        "group": ["chat", "draw", "code", "office", "video", "audio"]
      },
      "refs": {
        "linkId": { "collection": "links", "required": false }
      }
    },
    "links": {
      "id": "id",
      "required": ["id", "name", "url"]
    }
  }
}
```

字段说明：

- `id`：主键字段名，默认 `id`
- `required`：必填字段，空字符串也算缺失
- `unique`：唯一值字段，比较时去空格、转小写，所以 `Doubao` 和 `doubao` 会被判为重复
- `enums`：枚举字段和允许值
- `refs`：引用字段，`collection` 指向目标集合，`required` 表示这个引用是否必填
- `path`：如果你的集合嵌在对象里（比如 `data.content.tools`），用 `path` 指定路径

## 一些设计上的取舍

**规范化比较，但只在唯一性和 id 上做。** `Doubao` 和 `doubao` 判为重复，是因为它们生成路由时确实会撞。但字段内容本身不规范化，因为中文的空格和标点有实际含义。

**默认查「无人引用」，可以用 `--no-orphans` 关掉。** 这个检查在有些数据模型里是误报——比如分类表本来就可能存在暂时没有内容的分类。关掉它换来更干净的报告，这个选择交给你。

**不做类型检查。** 判断 `"2026"` 是不是应该写成 `2026`，需要知道业务语义，工具猜不准。类型错误在 JSON 里表现太隐蔽，硬查会产生大量误报，不如留给人看。

**不合并、不修复。** 它只报告。自动修复数据是另一回事，风险大得多。

## 关于

代码是从一个内容站的日常维护里长出来的，那个站收录 AI 工具和建站资源，日常会写一些排查记录，都放在 [Kan112 AI 网址导航](https://www.kan112.com/) 上。

数据质量这类问题写出来不太好看，因为大部分时间它不出事。但出事的时候往往已经扩散了几十处，改一遍要半天。

## 使用许可

不是开源项目，是源码可见。保留所有权利。

- 可以直接用：读源码、抄片段学习、个人非商业自用；
- 需要事先取得书面授权：任何商业用途、再分发、去掉版权声明、基于它做竞争产品。

完整条款见 [LICENSE](LICENSE)，商业授权走[站点联系页](https://www.kan112.com/contact.html)。
