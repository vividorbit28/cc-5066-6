# 几何细节烘焙器（Geometry Detail Baker）

把高细节网格的表面信息，通过逐纹素射线投射，烘焙到带 UV 的低细节网格上。
初版输出**切线空间法线**与**显式支持的距离信息**，并在低模上用软件光栅渲染器
实际着色验证，而不是展示高模截图。

## 设计要点（对应需求）

- **逐纹素查询来自低模参数位置**：在 UV 空间用同一套边缘函数光栅化，边界与
  内部纹素采用完全相同的重心/笼体插值规则（见 `src/baker.js:rasterizeUV`）。
- **统一的切线框架与法线变换**：切线框架由低模三角的 UV 梯度构建，高模法线经
  同一个世界→切线矩阵写入贴图（`src/math.js:tangentFrame`、`worldToTangent`）。
- **笼体范围与投射方向可见**：内外笼沿低模顶点法线推/拉生成，射线从内笼穿过
  表面到外笼；笼体、射线、命中点都导出为 OBJ/调试图层，可在界面查看。
- **两种命中选择，拒绝盲目取最近三角**：
  - `nearest`：纯射线最近点，会暴露跨部件/背面穿透；
  - `ownership`（默认）：按低模纹素的部件归属，只在同部件正面候选中取最近，
    保护薄壳背面、防止跨到相邻不相关零件。被拒绝的候选单独记录。
  - `test/make_models.js` 的折回薄件场景给出可复现铁证：折回的背面离内笼更近，
    `nearest` 在全部 52900 个覆盖纹素上跨部件选错（状态全冲突），`ownership`
    全部干净命中（见 `output/runs/fold/policy_comparison.json`）。
- **诊断保留**：未命中、多候选冲突、退化 UV、跨部件、背面等都有独立状态码与
  图层，绝不静默丢弃或用扩大射线范围“保证命中”。
- **成功率 ≠ 正确率**：报告分别给出命中率（任意命中）与正确率（干净、归属正确
  的命中），归属保护单独计数。
- **真实渲染检验**：`src/render.js` 是零依赖 z-buffer 光栅器，对低模取烘焙法线
  贴图做双线性切线空间扰动着色，并提供关闭贴图的对照渲染。

## 目录结构

```
src/        核心实现（UMD，Node 与浏览器共用同一份代码）
  math.js     向量/矩阵、切线框架
  mesh.js     网格数据结构、OBJ 读写、部件归属
  raycast.js  BVH + Möller–Trumbore 射线求交（返回全部候选与前/背面标记）
  baker.js    笼体、UV 光栅化、命中选择、逐纹素烘焙与诊断图层
  image.js    零依赖 PNG 编码与图层着色
  render.js   低模软件光栅渲染（消费烘焙法线）
  runner.js   批量烘焙、贴图/调试/渲染/报告导出
  cli.js      命令行（辅助）
web/        图形界面（主要入口），调用同一个 src/*.js
test/       模型生成、几何/策略核心断言、维护规则校验、净目录资料校验、jsdom GUI 工作流
samples/    可重新烘焙的维护部件集（同名螺钉、拆分罩壳、重命名/拆分/rogue 变体）
tools/      本地静态服务器
doc/        使用文档
output/     模型、各场景烘焙产物（贴图、渲染、命中几何、JSON 报告与 SHA-256 清单）
```

## 快速开始

图形界面入口与完整说明见 **[doc/usage.md](doc/usage.md)**。

```bash
npm run all                  # 生成样例、全部校验、GUI 工作流，并产出 256px 烘焙结果
npm run serve                # 启动本地服务后打开 web/index.html（主要图形入口）

npm run sample               # 只重新生成 samples/maintenance 可重烘部件集
npm run validate:maintenance # 投射身份、重命名/拆分、rogue 背面、扣留发布检查
npm run validate:assets      # 在系统临时净目录重烘并核对 SHA-256 清单，拒绝伪报/陈旧文件
npm run test:gui             # jsdom 中真实选择 OBJ、点击烘焙并检查异常/图层
```

图形界面可直接选择本地低模与高模 OBJ，也可载入维护部件集/rogue 场景；运行状态、
贴图细节异常、法线误差/投射偏差、未知对应区域和身份不一致计数都会显示在窗口中。
命令行只作为批量与 CI 辅助，参数约定见 **[doc/usage.md](doc/usage.md)**。

无第三方运行时依赖，仅使用 Node 内置模块；浏览器端无需构建步骤。GUI 自动化测试在
找不到仓库内 `jsdom` 时会尝试 `/tmp/pwtest/node_modules/jsdom`。
