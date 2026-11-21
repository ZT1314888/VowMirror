# 公开展示素材

公开资源的唯一清单为 [web/public/manifest.json](../web/public/manifest.json)。本轮于 2026-11-19 核验 Wikimedia Commons 原始文件页的 CC0 声明和 2017-06-05 前发布记录；两张图均允许复制、修改和商业再分发。文件同源托管，EXIF、IPTC 和注释已移除，实际产物摘要由自动化检查验证。

| 文件 | 用途 | 来源及公开作者 | 许可 |
| --- | --- | --- | --- |
| `wedding-example.jpg` | 明确标记的示例照片，永不作为生成结果或用户照片 | [Wedding couple on a footbridge](https://commons.wikimedia.org/wiki/File:Wedding_couple_on_a_footbridge_(Unsplash).jpg)，Scott Webb，2015-05-05 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `florals.jpg` | 花卉首屏背景；没有人物 | [Aisle for a Wedding](https://commons.wikimedia.org/wiki/File:Aisle_for_a_Wedding_(Unsplash).jpg)，Shardayyy Photography，2016-07-24 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

2026-11-21 新增自托管展示字体（清单 `fonts` 数组），均同源托管、无外部 CDN 请求：

| 文件 | 用途 | 来源及作者 | 许可 |
| --- | --- | --- | --- |
| `fonts/cg-var-latin.woff2`、`fonts/cg-italic-latin.woff2` | 西文/数字展示衬线（字标、房间编号） | [Cormorant Garamond](https://github.com/google/fonts/tree/main/ofl/cormorantgaramond)，Christian Thalmann | [SIL OFL 1.1](https://openfontlicense.org/open-font-license-official-site/)（`OFL-cormorant-garamond.txt`） |
| `fonts/noto-serif-sc-400.woff2`、`fonts/noto-serif-sc-600.woff2` | 中文标题衬线（思源宋体） | [Noto Serif SC](https://github.com/google/fonts/tree/main/ofl/notoserifsc)，Google / Adobe | [SIL OFL 1.1](https://openfontlicense.org/open-font-license-official-site/)（`OFL-noto-serif-sc.txt`） |

思源宋体由官方可变字体以 pyftsubset 实例化（wght=400/600）并子集化至「GB2312 一级常用字 + 符号区 + 项目实际文案」共 4540 字符，单字重约 0.7 MiB；超集外的生僻字回退系统宋体。Cormorant Garamond 为 Google Fonts 官方 latin 子集，未改动字形数据。

主图原构图裁至颈部以下，没有可识别人脸。响应式布局通过 CSS 裁切展示，不宣称图片中的服装对应目录中的任一套装。30 套造型暂缺逐套核验的授权缩略图，按批准方案保留实际名称卡片；首组顺序为 W001、W004、W002、W003。

上传卡片仅显示用户自行选择的照片。示例无下载入口，原图下载仅在本次真实生成结果完整解码后开放。公开资源路由严格限于清单中的两个 JPEG 文件与四个 woff2 字体文件；私有素材目录不对浏览器开放。
