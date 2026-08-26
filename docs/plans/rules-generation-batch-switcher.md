# Rules 生成批次切换

## 范围与验收

- Generated Rules 将生成历史合并为批次选择器，不再把 Generation History 作为并列子导航。
- 直接进入 Rules 时默认展示全部待审核；从 Chat 进入时定位当前 `runId`。
- 批次与 draft / accepted / rejected 是两个独立筛选维度。
- “查看生成过程”回到对应 Chat；发布仍基于累计 accepted 规则，避免覆盖时丢失其他批次资产。

## Step 1：建立批次过滤模型

增加纯函数测试，验证全部候选与指定 `runId` 的隔离。

- 观察点：不同批次的相同状态候选不会混合。
- 验证方式：运行 Rules view model 单测。

## Step 2：打通 Chat → Rules 的 runId

Chat 打开生成规则时携带当前 Thread ID，App 将其传给 Rules。

- 观察点：从任意历史 Chat 打开 Rules，选择器定位对应批次。
- 验证方式：布局契约测试与组件行为检查。

## Step 3：合并 Generated Rules 与历史批次

Generated Rules 顶部增加批次选择器、候选数和“查看生成过程”；状态筛选继续作用于当前批次。

- 观察点：切换批次时表格立即更新；直接导航默认“全部待审核”。
- 验证方式：App 测试、构建与真实窗口检查。

## Step 4：回归与上下文同步

同步 `memory/process.md`，执行 Core/App 全量测试和构建。

- 观察点：审核、编辑、接受、拒绝、Chat 跳转和发布没有回退。
- 验证方式：全量测试、构建与 `git diff --check`。
