# 合照检测模型与测试照片

生产二进制嵌入 [Pigo v1.4.6 的 facefinder][pigo]，共 239,632 字节。
它与 [Pico 的原始级联分类器][pico] 字节相同。启动时校验 SHA-256 后才加载：

```text
d8014993e7298c7b1865d1f8b855d6dbf4ec5c808bf879e2091ab6837abf90cd
```

两个项目均使用 MIT 许可。分发时保留 [Pigo 许可](LICENSE-pigo) 和 [Pico 许可](LICENSE-pico)。
应用镜像将这两份声明放在 `/usr/share/doc/vowmirror/`。

测试照片来自 NASA 的 [Apollo 11 机组合照 S69-31740][nasa]。
这是美国联邦政府公开作品，按 [NASA 媒体使用说明][usage] 用于测试；NASA 未认可本产品。
照片不作为婚礼素材。以下坐标以 [1280 × 1027 的原图][source] 左上角为原点，右、下边界不包含在裁剪内。

| 测试文件 | 裁剪区域 (左, 上, 右, 下) | 输出 |
| --- | --- | --- |
| [one.jpg](testdata/one.jpg) | 100, 140, 475, 515 | 300 × 300，一张脸 |
| [two.jpg](testdata/two.jpg) | 85, 10, 835, 510 | 480 × 320，两张脸 |
| [three.jpg](testdata/three.jpg) | 80, 10, 1220, 530 | 660 × 301，三张脸 |
| [two-exif6.jpg](testdata/two-exif6.jpg) | 同双脸样本 | 像素逆时针旋转 90°，EXIF Orientation 为 6 |

夹具使用 Pillow 12.2.0，以 JPEG quality 90 保存。旋转样本模拟手机保存方向的方式。
原始 JPEG 的 SHA-256：

```text
9635fa101bdb1bb126713029186ef98e94795adf9db8fe551b93cfe267d906df
```

[pigo]: https://github.com/esimov/pigo/blob/v1.4.6/cascade/facefinder
[pico]: https://github.com/nenadmarkus/pico/blob/master/rnt/cascades/facefinder
[nasa]: https://images.nasa.gov/details/S69-31740
[source]: https://images-assets.nasa.gov/image/S69-31740/S69-31740~medium.jpg
[usage]: https://www.nasa.gov/nasa-brand-center/images-and-media/
