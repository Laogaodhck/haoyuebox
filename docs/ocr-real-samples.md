# OCR 真实素材抽检集

> 用途：与确定性合成评测（`tools/eval-ocr.cjs`）互补，用真实票据、表格、标签、文档和场景照检验生产管线。
> 位置：`testdata/ocr-real/`（已加入 `.gitignore`：含姓名、票号等个人信息，禁止入库或外发）。
> 自动报告：[ocr-real-report.md](ocr-real-report.md)，由 `node tools/eval-ocr-real.cjs --write` 生成。

---

## 一、样本构成

| ID | 类别 | 主要压力点 | PaddleOCR 源文件 |
| --- | --- | --- | --- |
| boarding-pass | 票据 | 红章污损、中英混排、小号座位/时间字段 | `doc/imgs/00006737.jpg` |
| care-label | 标签 | 洗涤图标夹排、℃ 符号、紧密行距 | `doc/imgs/00009282.jpg` |
| equity-table | 表格 | 框线表格、合并表头、小号数字与百分比 | `doc/imgs/00015504.jpg` |
| lab-table | 表格 | 五列检验表、`<`/`--`/`↓` 符号 | `doc/imgs/00018069.jpg` |
| train-ticket | 票据 | 反光、倾斜、红色票号、小号数字 | `doc/imgs/00056221.jpg` |
| lab-report-photo | 文档 | 手机拍摄、边缘裁切、小数点丢失 | `doc/imgs/00057937.jpg` |
| math-worksheet | 文档 | 数学符号（×）、全角标点、填空横线 | `doc/imgs/00059985.jpg` |
| baby-tag | 标签 | 花背景、吊牌小字、条码数字 | `doc/imgs/00077949.jpg` |
| bank-receipt | 票据 | 签购单小字、卡号/姓名遮挡、红章 | `doc/imgs/00111002.jpg` |
| bank-sign | 场景 | 门头大字 + LED 滚动字、玻璃反光 | `doc/imgs/00207393.jpg` |
| gate-sign | 场景（竖排） | 竖排中文、金属反光 | `doc/imgs/1.jpg` |
| haircare-label | 标签 | 绿色标题、长成分名、括号错配 | `doc/imgs/11.jpg` |
| street-sign | 场景 | 绿底金字、低对比度、植被背景 | `doc/imgs/12.jpg` |

主场景指标统计 10 张：前 9 张（票据 / 表格 / 标签 / 文档）加 `haircare-label`；`bank-sign`、`gate-sign`、`street-sign` 三张场景照单独统计，用于标注当前管线边界。

## 二、GT 约定

- 一行一条肉眼可辨的正文；计算前做 NFKC、去空白、小写归一。
- **不计入 GT**：水印、店铺/网站字样、相机 EXIF 叠加、装饰图标与箭头、被遮挡或裁切掉一半的字段。
- 关键字段写在 `manifest.json` 的 `fields` 中，归一化后按子串匹配，用于衡量金额、号码、日期等业务字段的命中率。
- 表格样本另有 `<id>.table.json`，按行列与识别出的表格对应，计算单元格完全一致率。
- GT 保留人工分行；版面重建会区分正文页（并段）与票据/标签/表单（逐行保留），「行召回」反映结构还原程度。

## 三、运行与扩展

```bash
node tools/eval-ocr-real.cjs                 # 指标汇总
node tools/eval-ocr-real.cjs --dump          # 逐张打印 GT / 识别原文 / 表格
node tools/eval-ocr-real.cjs --only=equity-table,lab-table
node tools/eval-ocr-real.cjs --write         # 更新 docs/ocr-real-report.md
```

新增样本：

1. 图片放到 `testdata/ocr-real/<id>.jpg`；
2. 人工核对并写 `<id>.gt.txt`（一行一条）；
3. 在 `manifest.json` 增加 `{ id, file, gt, category, fields, table? }`；
4. 先 `--dump` 复核 GT，再 `--write` 更新报告。

指标口径与 `tools/_ocr-metrics.cjs` 共用：CER、字符命中、精确率、F1、行召回、表格单元格准确率；`eval-ocr.cjs` 与本工具保持同一套算法。

## 四、来源与使用限制

样例取自 [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) `release/2.7` 分支 `doc/imgs/`（仓库 Apache-2.0），仅用于本地离线精度抽检。图片可能包含姓名、票号、病历等个人信息，因此不在本仓库分发；如需对外使用，请自行确认原始权利与隐私合规。当前基线见 [ocr-real-report.md](ocr-real-report.md) 和 [ocr-accuracy-optimization.md](ocr-accuracy-optimization.md) 第八节。
