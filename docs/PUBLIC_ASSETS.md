# 公开展示素材

公开资源的唯一清单为 [web/public/manifest.json](../web/public/manifest.json)。
原有两张 JPEG 于 2026-11-19 核验 Wikimedia Commons 原始文件页的 CC0 声明和 2017-06-05 前发布记录，
均允许复制、修改和商业再分发。文件同源托管，EXIF、IPTC 和注释已移除，实际产物摘要由自动化检查验证。

| 文件 | 用途 | 来源及公开作者 | 许可 |
| --- | --- | --- | --- |
| `wedding-example.jpg` | 明确标记的示例照片，永不作为生成结果或用户照片 | [Wedding couple on a footbridge](https://commons.wikimedia.org/wiki/File:Wedding_couple_on_a_footbridge_(Unsplash).jpg)，Scott Webb，2015-05-05 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `florals.jpg` | 花卉首屏背景；没有人物 | [Aisle for a Wedding](https://commons.wikimedia.org/wiki/File:Aisle_for_a_Wedding_(Unsplash).jpg)，Shardayyy Photography，2016-07-24 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

2026-11-21 新增自托管展示字体（清单 `fonts` 数组），均同源托管、无外部 CDN 请求：

| 文件 | 用途 | 来源及作者 | 许可 |
| --- | --- | --- | --- |
| `fonts/cg-var-latin.woff2`、`fonts/cg-italic-latin.woff2` | 西文/数字展示衬线（字标、房间编号） | [Cormorant Garamond](https://github.com/google/fonts/tree/main/ofl/cormorantgaramond)，Christian Thalmann | [SIL OFL 1.1](https://openfontlicense.org/open-font-license-official-site/)（`OFL-cormorant-garamond.txt`） |
| `fonts/noto-serif-sc-400.woff2`、`fonts/noto-serif-sc-600.woff2` | 中文标题衬线（思源宋体） | [Noto Serif SC](https://github.com/google/fonts/tree/main/ofl/notoserifsc)，Google / Adobe | [SIL OFL 1.1](https://openfontlicense.org/open-font-license-official-site/)（`OFL-noto-serif-sc.txt`） |

思源宋体由官方可变字体以 pyftsubset 实例化（wght=400/600），
并子集化至「GB2312 一级常用字 + 符号区 + 项目实际文案」共 4540 字符，单字重约 0.7 MiB；
超集外的生僻字回退系统宋体。Cormorant Garamond 为 Google Fonts 官方 latin 子集，未改动字形数据。

造型页使用用户提供的 30 套预制展示图，编号与现有目录 W001–W030 一一对应，名称仍来自目录 API。
来源如实记录为用户提供的预制图，不套用上述 JPEG 的 CC0 声明。
交付的 WebP 为 30 张 2400×1040 展示图与对应的 320×240 缩略图，均无元数据。
仓库只保留成品文件与清单摘要，不含原始 PNG 和可复现的转换脚本，
因此下列信息属于来源记录而非本轮可复核的证据。
原图未在本仓库内修改；转为 WebP 所用的工具与质量参数是交付时的来源记录，仓库内无法复现。
清单 `outfitPreviews` 记录每套 ID、取景焦点、两种文件的尺寸与 SHA-256，摘要只能证明成品未被改动。
首组顺序保留 W001、W004、W002、W003。

展示图仅供「02 造型」预览，页面标注“造型示例”。未选择时显示 W001，但不自动选择该服装。
选择只更新服装 ID；生成请求中的合照始终使用用户上传照片，展示图与缩略图不进入模型请求。
主图按需加载、解码后切换，加载失败明确提示并支持重试。

固定场馆使用用户提供的 7 张场馆展示图，对应目录 `V001`–`V007`（清单 `venuePreviews` 数组），
同样记录为公开展示示例（`venue-example-only`），不进入模型生成请求或结果。
交付的 WebP 为 7 张 `2400×1600` 展示图与对应的 `320×240` 缩略图，均已清除 EXIF/IPTC/ICC 元数据。
选中固定场馆时复用「02 造型」的预设画框、卡片与加载/重试流程；保留原背景与上传照片时继续完整显示。

2026-11-23 新增用户试听确认的 2.6 秒请柬音效 `invitation-opening-petals.mp3`，
对应清单 `audio` 数组。由以下两段 CC0 素材的高质量 MP3 预览裁剪、滤波、混合并淡出：

| 来源 | 作者 | 原片截取范围 | 许可 |
| --- | --- | --- | --- |
| [Page Turn Free](https://freesound.org/people/AardsReal/sounds/842183/) | AardsReal | 0.10–0.53 秒 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| [Chimes Sparkle](https://freesound.org/people/lukabea/sounds/660493/) | lukabea | 3.52–5.85 秒 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

两段来源均允许修改、商业使用和再分发，无强制署名要求。清单记录来源、下载地址、裁剪范围和摘要。
上线 MP3 的来源记录为与试听确认文件逐字节一致；仓库内没有试听原件或其摘要，
因此可自动化复核的只有清单摘要与成品文件一致，以及浏览器解码时长与 `durationSeconds` 相符。
音效只在用户点击火漆或键盘开启请柬时播放一次，
正常开启保留完整尾音，主动跳过或离开页面时停止。播放失败明确记录到控制台，页面交互仍可继续。

上传区仅显示用户自行选择的照片。示例无下载入口，原图下载仅在本次生成结果完整解码后开放。
公开素材静态路由仅允许清单文件、原有两个 JPEG、四个 woff2 字体，
固定编号的 `outfits/W001.webp` 至 `W030.webp`、`venues/V001.webp` 至 `V007.webp`
及对应的 `-thumb.webp` 文件和上述单个 MP3。
桌面目录、私有素材目录、后端参考图、目录索引及其他编号不对浏览器开放。
