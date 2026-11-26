# 使用指南

## 图形入口（主要使用方式）

几何烘焙的**图形界面入口**是 `web/index.html`。界面按钮直接调用
`src/baker.js` 中的真实几何烘焙实现，不存在固定/占位贴图；运行说明以图形入口为主，
命令仅作辅助，用于批量与 CI。

两种打开方式：

1. 本地服务器（推荐）

   ```bash
   npm run serve
   # 然后浏览器打开 http://localhost:8123/web/index.html
   ```

2. 直接用浏览器打开 `web/index.html`（`file://` 也可运行，模型通过
   `FileReader` 在浏览器内解析，无需上传到任何服务器）。

### 图形界面操作流程

1. **实际选择高低模**
   - 在「低模（含 UV）」选择 `.obj`；低模缺 UV 会直接报错。
   - 在「高模」选择对应的高模 `.obj`。
   - 或点击「载入内置测试场景」，可切换深凹槽平板 / 薄壳 / 相邻分离零件 /
     折回薄件 / 维护部件集。维护部件集包含两个同名「螺钉」、旧工程已拆分的
     `shroud_left` 与 `shroud_right` 罩壳，以及重命名、拆分和失效来源对照。
2. **设置烘焙参数**：贴图尺寸、外笼距离、内笼距离、命中选择策略。
3. 点击「烘焙」。状态栏会先显示 `烘焙中…` / `data-running="true"`，完成后显示耗时。
4. 结果区同时呈现：
   - 贴图细节：法线、距离、带符号距离、法线误差热图；
   - 投射偏差：干净/冲突/未命中/未知对应区域、归属保护、投影身份和最大法线误差；
   - 诊断状态、未知对应遮罩、笼体/射线调试图层与低模实时渲染。
5. 「低模渲染」图层可勾选「关闭法线贴图（对照）」；「导出当前图 PNG」可保存渲染结果。
6. 「保存配置 JSON」可落盘当前参数，之后用「载入配置」恢复。

## 当前实现约定（以 `projection-rules.json` 为准）

这些是本仓库代码与校验使用的约定。**外部工具（如 Blender、Substance Painter、
xNormal）的笼体距离、射线方向、切线轴向或默认参数，不会被当作当前实现保证**；
只有本文件、`projection-rules.json` 和实际解析后的 CLI/GUI 参数可作为证据。

### 投射笼与射线方向

- 低模平滑顶点法线记为 `N`。
- 外笼：`p_outer = p + N * outerDistance`。
- 内笼：`p_inner = p - N * innerDistance`。
- 射线从内笼插值点射向外笼插值点：
  `direction = inner_to_outer_normalized(cageOuterPoint - cageInnerPoint)`，
  即机器可读规则中的 `inner_to_outer`。
- 射线区间为 `[0, |cageOuterPoint - cageInnerPoint|]`，内外笼距离均参与，
  不靠盲目扩大全局射程掩盖 miss。
- 本仓库字段 `frontFacing` 是**来源法线与外向投射方向一致**的身份筛选：
  `dot(hit.geometricNormal, rayDirection) >= 0`。它不是实时渲染中“射线看到
  三角形正面”的同义词；薄壳内壁或隔壁背面会形成负对齐候选并被 ownership 拒绝。
- 旧薄壳示例的绕序已按上述方向校正：`shell_outer` 的几何法线径向朝外，
  `shell_inner` 的几何法线朝向腔体/轴线；因此外向射线先遇到的内壁候选是
  负对齐背面，而不是把外笼方向反装。

### 切线空间与贴图行序

- `T` 沿 UV 的 U 梯度正交化，`B = N × T`，保持 `T × B = N` 的右手系。
- `worldToTangent(T,B,N)` 按列主序存储；`M.mulVec` 的结果是
  `[dot(T,v), dot(B,v), dot(N,v)]`。
- 法线贴图采用 OpenGL 风格 `+Z`：中性法线编码为 `(128,128,255)`，
  `RGB = xyz * 0.5 + 0.5`。
- 本实现的缓冲行 `py=0` 对应 `v=0`；PNG/画布按同一数组行序呈现，软件渲染器也按
  `uv.y * size` 采样，避免文档与执行证据使用两套行序。

### 部件身份与显示标签

- `partNames` 只是可重复的显示标签；`partIds` 才是投影身份。
- 两个螺钉可以同时显示为「螺钉」，稳定 ID 分别是 `screw_a`、`screw_b`。
- 旧工程已拆分的罩壳保留为 `shroud_left`、`shroud_right`，即使标签相同也不合并。
- **重命名只能改标签**：稳定 ID、面顺序和投影来源键
  `<partId>:face_<index>` 不应变化。
- **真正拆分**会改变部件 ID/筛选规则；受影响纹素必须重新认领合法来源。
  维护样例在 96px、内外笼均为 0.2 时，首次来源变化纹素固定为
  `px=52, py=33, index=3220`，新来源部件为 `cover_left`。
- 无法建立新旧部件对应关系的区域标记为
  `unknown_correspondence`（状态码 5，青色），不得猜测来源，也不得发布该贴图。

## 参数默认值（不要混淆核心默认与界面预设）

| 参数 | 底层 `bake()` 默认 | 图形界面预设 | runner/CLI 与 `npm run all` |
| --- | ---: | ---: | ---: |
| `size` | `256` | `128` | CLI 配置默认 `256`；交付烘焙 `256` |
| `outerDistance` | `0.5` | `0.4` | CLI 配置默认 `0.5`；交付烘焙 `0.4` |
| `innerDistance` | `0.5` | `0.4` | CLI 配置默认 `0.5`；交付烘焙 `0.4` |
| `policy` | `ownership` | 默认 `ownership`，可手动切 `nearest` | 固定同时生成 `ownership` 与 `nearest` 对照 |

文档若写出其他数值，必须能在 `projection-rules.json`、CLI help 或实际报告中核对。

## 命令行（仅辅助批量/CI）

命令行不是主要入口，只用于批量烘焙、复现和自动化检查：

```bash
node src/cli.js \
  --low output/models/groove_low.obj \
  --high output/models/groove_high.obj \
  --out /tmp/groove-bake \
  --size 256 --outer-distance 0.4 --inner-distance 0.4 \
  --save-config /tmp/bake-config.json
```

也可用 `--config my-config.json` 从保存的配置运行。

## 维护部件集与可执行投射规则

生成可重新烘焙的 OBJ + 规则清单：

```bash
npm run sample
# 输出到 samples/maintenance/
```

运行投射规则维护校验（重命名、真实拆分、同名螺钉、旧罩壳、薄壳、邻近表面、
投影身份、法线误差、停止发布失效贴图）：

```bash
npm run validate:maintenance
# 默认使用系统临时净目录；也可指定一个会被清空的目录：
node test/validate-maintenance.js --clean-dir /tmp/maintenance-clean
```

该检查会写出 `maintenance-validation.json`，其中包含：

- 重命名前后的首个来源变化（必须为 `null`）；
- 拆分后首次改变来源的纹素 `(52, 33, 3220)`；
- 失效射线示例：只命中 `rail_back` 且 `frontFacing=false`，原因是 `backface_only`；
- 各旧场景的投影身份不匹配数、法线误差均值/95 分位/最大值；
- 发布目录中哪些贴图保留已确认版本、哪一张被扣留。

## 净目录烘焙资料校验

烘焙资料校验必须在**净目录**执行，不读取或信任手改的 `output/` 报告：

```bash
npm run validate:assets
# 等价别名：npm run validate:bake
# 或指定净目录（脚本会先删除并重建它）：
node test/validate-bake-assets.js --clean-dir /tmp/bake-assets-clean
```

它会在净目录重新生成几何、执行真实 `runBake`、读回 PNG/report/manifest，
再独立烘焙并比对计数、投影身份和法线误差；`bake-manifest.json` 记录每个产物的
字节数与 SHA-256。任何缺失、哈希不符、额外陈旧文件或报告伪报都会失败。

一次性运行模型生成、核心断言、维护校验、净目录资料校验、GUI 工作流和
256px 交付烘焙：

```bash
npm run all
```

## 输出内容（每个场景、每种策略各一份）

| 文件 | 含义 |
| --- | --- |
| `normal_tangent.png` | 切线空间法线，经统一的世界→切线矩阵写入 |
| `distance_abs.png` | 显式距离通道：沿低模法线位移的绝对值 |
| `distance_signed.png` | 带符号距离（暖色外凸 / 冷色内凹） |
| `ray_distance.png` | 原始射线参数（诊断用，不等于距离通道） |
| `normal_error.png` | 编码→解码后的法线角度误差热图（度） |
| `status.png` | 命中/未命中/冲突/UV 外/退化/未知对应区域 |
| `unknown_mask.png` | 无法确认投射来源、必须扣留发布的区域 |
| `protected_mask.png` | ownership 成功拒绝跨部件或背面候选的纹素 |
| `candidate_count.png` | 每条射线的候选三角数量 |
| `hit_mask.png` | 是否存在有效命中 |
| `debug/rays.obj` | 射线方向线段 |
| `debug/cage_outer.obj`、`cage_inner.obj` | 内外笼体 |
| `debug/hits_chosen.obj`、`hits_rejected.obj`、`miss_ends.obj` | 采纳/拒绝/未命中几何 |
| `render/*_low_flat.png`、`*_baked.png` | 低模无贴图 vs 烘焙法线渲染对照 |
| `report.json` | 计数、成功率、正确率、身份与法线误差证据 |
| `bake-manifest.json` | 产物清单、参数、字节数与 SHA-256 |
| `policy_comparison.json` | nearest 与 ownership 的逐项差异 |

重新烘焙会清理上一轮由清单记录的策略目录和诊断产物，避免陈旧 PNG/JSON 被误认成
当前结果；净目录校验还会主动制造陈旧文件并验证其被清除。

## 测试

```bash
npm test                    # 几何/策略/笼体/边界/切线断言
npm run validate:maintenance
npm run validate:assets
npm run test:gui            # jsdom 内驱动真实文件选择/烘焙/图层切换
npm run all                 # 上述检查 + 256px 可复现交付烘焙
```
