# 使用指南

## 图形入口（主要使用方式）

几何烘焙的**图形界面**位于 `web/index.html`，界面上的每个按钮都直接调用
`src/baker.js` 中的真实几何烘焙实现，不存在固定/占位贴图。

两种打开方式：

1. 本地服务器（推荐）

   ```bash
   npm run serve
   # 然后浏览器打开 http://localhost:8123/web/index.html
   ```

2. 直接用浏览器打开 `web/index.html`（`file://` 也可运行，模型通过
   `FileReader` 在浏览器内解析，无需上传到任何服务器）。

### 图形界面操作流程

1. **选择模型**
   - 「选择文件」分别载入带 UV 的低模 OBJ 与高模 OBJ；低模缺 UV 会直接报错。
   - 或点击「载入内置测试场景」，在深凹槽平板 / 薄壳 / 相邻分离零件 /
     折回薄件间切换。折回薄件专门用于对照：nearest 会在全图跨部件选错，
     ownership 则保持干净命中。
2. **设置烘焙参数**
   - 贴图尺寸、外笼距离、内笼距离、命中选择策略。
   - 命中选择：
     - **按部件归属（ownership，默认）**：只接受与低模纹素同部件、且正面
       命中的最近三角，保护薄部件背面、拒绝跨到相邻零件。
     - **按射线最近点（nearest）**：不做部件判断，严格取最近三角，用于对照
       暴露跨部件/背面穿透问题。
3. **点击「烘焙」**。结果区会显示：
   - 干净命中 / 冲突 / 未命中 / 归属保护数量；
   - **正确率**（干净命中占比）与**命中率**（含冲突的任意命中占比）分开统计；
   - 法线、绝对距离、带符号距离、诊断状态、归属保护层、低模实时渲染、
     投射/笼体调试等图层。
4. 「低模渲染」图层可勾选「关闭法线贴图（对照）」，直观比较低模本身与烘焙后
   的呈现；「导出当前图 PNG」可保存渲染结果。
5. 「保存配置 JSON」可把当前参数落盘，之后可用「载入配置」恢复。

## 命令行（仅辅助批量/CI）

命令行不是主要入口，只用于批量烘焙与自动化测试：

```bash
node src/cli.js \
  --low output/models/groove_low.obj \
  --high output/models/groove_high.obj \
  --out output/runs/groove \
  --size 256 --outer-distance 0.4 --inner-distance 0.4 \
  --save-config my-config.json
```

也可用 `--config my-config.json` 从保存的配置运行。

## 输出内容（每个场景、每种策略各一份）

| 文件 | 含义 |
| --- | --- |
| `normal_tangent.png` | 切线空间法线，经统一的世界→切线变换写入 |
| `distance_abs.png` | 显式距离通道：沿低模法线位移的绝对值 |
| `distance_signed.png` | 带符号距离（暖色外凸 / 冷色内凹） |
| `ray_distance.png` | 原始射线参数（诊断用，不等于距离通道） |
| `status.png` | 逐纹素状态：命中/未命中/冲突/UV 外/退化 |
| `protected_mask.png` | ownership 成功拒绝跨部件或背面候选的纹素 |
| `candidate_count.png` | 每条射线的候选三角数量 |
| `hit_mask.png` | 是否存在有效命中 |
| `debug/rays.obj` | 射线方向线段 |
| `debug/cage_outer.obj`、`cage_inner.obj` | 内外笼体 |
| `debug/hits_chosen.obj`、`hits_rejected.obj`、`miss_ends.obj` | 采纳/拒绝/未命中几何 |
| `render/*_low_flat.png`、`*_baked.png` | 低模无贴图 vs 烘焙法线渲染对照 |
| `report.json` | 计数、成功率、正确率、原因统计 |
| `policy_comparison.json` | nearest 与 ownership 的逐项差异 |

## 测试

```bash
npm test        # 30 项几何/策略/笼体/边界断言
npm run test:gui  # jsdom 内驱动图形界面工作流
npm run all     # 生成模型 + 全部断言 + GUI 工作流 + 256px 交付烘焙
```
