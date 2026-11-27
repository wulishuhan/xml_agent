# 文言文协议（wenyan）实验说明

> 实验分支 `experiment/wenyan-protocol`。**非正规流程**：默认协议仍是 XML，WebUI 设置面板未暴露此选项，只能通过 CLI `--protocol wenyan` 或编程传入启用。XML / JSON 行为完全未改。

## 它是什么

第三套动作协议：**提示词用纯文言行文，模型的动作输出也是纯文言**。共用同一套执行层（runtime + actions），只替换"模型回复 → `{action, params}` 信封"的解析与提示词。

设计动机是验证一个假设：XML/JSON 的标签、键名、引号、括号是"语法骨架开销"，文言文用单字动词 + 简短分隔符可能以更少 token 传达同等信息。

## 语法（单字动词 + 空格或 ｜ 分隔 + 「」 包正文）

| 内置动作 | 文言令 | 紧凑写法（推荐） | 旧写法（仍兼容） |
|---|---|---|---|
| read | 阅 | `阅 a.js`、`阅 a.js 100 4000` | `阅｜a.js｜100｜4000` |
| write | 书 | `书 a.js「console.log(1);」` | `书｜a.js｜「console.log(1);」` |
| edit | 改 | `改 a.js「旧」「新」`（末加 `全` 表示 all=true） | `改｜a.js｜「旧」｜「新」｜全` |
| exec | 行 | `行 npm test` | `行｜npm test` |
| screenshot | 摄 | `摄 screen shot.png` | `摄｜screen｜shot.png` |
| answer | 答 | `答「最终答案」` | `答｜「最终答案」` |
| done | 毕 | `毕` | — |

- 紧凑写法用空格代替 `｜`，省掉分隔符 token；正文裹在 `「」` 里，可含换行与 `｜`（解析时先抠出正文再拆骨架，不会被切断），正文内勿含 `」`。
- `行` 例外：空格后的整串都是命令，不会被拆开。
- 容忍 ``` 围栏。参数校验直接复用 `BUILTIN_ACTION_SCHEMAS`，与 XML/JSON 一致（如非法 `limit` 会报错）。
- 不注入插件动作示例（插件 usage 均为 XML/JSON 写法，会带偏文言会话）。

## 改动文件（全部在实验分支）

| 文件 | 作用 |
|---|---|
| `parse/wenyan-action.js` | 新增：文言 → 信封解析器；兼容空格紧凑写法与旧 `｜` 写法 |
| `parse/action.js` | `SUPPORTED_PROTOCOLS` 加 `wenyan`；解析器改显式映射，默认仍 xml |
| `prompts/wenyan/`（7 文件） | 新增：文言版 system / variants / first / runtime / error / done / send-error；提示词已二次压缩 |
| `prompts/protocol.js` | 模块选择由二元三元改为三路显式映射 |
| `test/unit/test-dual-protocol.js` | 协议清单断言 +9 条 wenyan 用例（43/43） |
| `test/wenyan-token-benchmark.js` | 新增：三格式 token 节省基准（动作/首轮/回贴/10 步累计），已挂进 `test:unit` |
| `package.json` | `test:unit` 末尾挂入基准脚本 |

未改：`config/schema.js`（ENUM 仍 `[xml,json]`）、WebUI、`providers/`、`agent/step.js`、根目录 prompts（保住指纹测试）。

## 节省实测（同语义三格式对比，启发式估算）

口径：CJK 1 字≈1 token、ASCII 4 字符≈1 token（`webui/session/context-budget.js` 的 `estimateTokens`）。三者同一把尺子，相对比例可信；真实值随 tokenizer 浮动。

### 输出侧（模型每轮给的动作）

| 场景 | XML (字符/token) | JSON | 文言 | 文言较 XML 省 |
|---|---|---|---|---|
| 读文件 | 27 / 7 | 50 / 13 | 14 / 5 | 28.6% |
| 续读(带偏移) | 49 / 13 | 72 / 18 | 19 / 6 | 53.8% |
| 建文件 | 61 / 16 | 80 / 20 | 30 / 10 | 37.5% |
| 改一处 | 124 / 31 | 110 / 28 | 46 / 16 | 48.4% |
| 执行命令 | 26 / 7 | 49 / 13 | 10 / 4 | 42.9% |
| 截图 | 60 / 15 | 99 / 25 | 32 / 9 | 40.0% |
| 答复 | 33 / 12 | 47 / 15 | 7 / 7 | 41.7% |
| 收尾 | 7 / 2 | 29 / 8 | 1 / 1 | 50.0% |
| **合计** | **387 / 103** | **536 / 140** | **159 / 58** | **43.7%** |

**动作合计：文言 vs XML 省 43.7% token，vs JSON 省 58.6% token。**

### 输入侧（每会话首轮系统提示词）

| 协议 | 字符 | token |
|---|---|---|
| XML | 1431 | 739 |
| JSON | 4206 | 1311 |
| 文言 | 531 | 397 |

**首轮提示词：文言较 XML 省 46.3%，较 JSON 省 69.7%。**

### 输入侧（每轮结果回贴，重复发送）

| 协议 | 成功 (字符/token) | 失败 (字符/token) |
|---|---|---|
| XML | 256 / 132 | 165 / 93 |
| JSON | 301 / 127 | 186 / 99 |
| 文言 | 108 / 51 | 103 / 53 |

**每轮成功回贴：文言较 XML 省 61.4%，较 JSON 省 59.8%。** 这段在 10 步任务里重复约 9 次，是二次优化的主要收益来源。

### 一轮 10 步累计估算

口径：首轮系统提示词 + 10 个动作（取上述 8 条均值）+ 8 次成功回贴 + 1 次失败回贴。

| 协议 | 累计 token |
|---|---|
| XML | 2017 |
| JSON | 2601 |
| 文言 | 931 |

**累计：文言较 XML 省 53.8%，较 JSON 省 64.2%。**

### 怎么看这些数字

- **输出侧动作**去掉了 `<read path="">` / `{"action":...}` 这类骨架，紧凑写法又省掉 `｜`，单字动词信息密度高。
- **每轮结果回贴里的紧凑 JSON 是数据本身**（`{"ok":true,...}`），三协议完全一致，会摊薄整轮对话的总体节省比例；但回贴的"协议措辞"已压到 30 token 上下，重复发送的成本大幅下降。
- 若结果是长文件内容，节省会被摊薄；若动作多、结果短，整体节省接近累计口径。
- 代价/风险：文言表达对模型的遵循度要求更高（真机首轮曾有会话残留污染导致格式漂移）；`「」` 正文里不能出现 `」`；这是启发式估算，不是精确 tokenizer 计数。

## 真机验证（Qwen）

### 优化后的紧凑写法（2026-11-27）

新会话、原始回复捕获，完整闭环 `completed`、4 步、0 解析错误；模型实际输出的每一令都是紧凑空格写法：

```
阅 a.js                              → read   ✓
改 a.js「const a = 2;」「const a = 3;」 → edit   ✓（精确匹配落盘，a=3）
答「a 的最终值为 3」                     → answer ✓
毕                                    → done   ✓
```

结论：紧凑写法不是靠解析器容错"猜中"的，模型确实按提示词输出了空格分隔 + `「」` 正文的纯文言动作。

### 多 provider 真机矩阵（同一任务：阅 → 改 → 答 → 毕）

| provider | 结果 | 模型原始回复 / 备注 |
|---|---|---|
| Qwen | `completed` 4 步 | `阅 a.js` / `改 a.js「旧」「新」` / `答「…」` / `毕` |
| ChatGPT | `completed` 4 步 | 首轮曾因会话惯性吐 XML `<read/>`，纠错提示后收敛；重跑为纯紧凑写法。首轮响应较慢，150s 超时不够，300s 可过 |
| DeepSeek | `completed` 4 步 | 全程紧凑写法，无纠错 |
| Grok | `completed` 4 步 | `答｜「…」` 与紧凑写法混用，解析器两种都支持 |
| GLM | `completed` 4 步 | 修复前 DOM 泄漏「思考过程」标题和 Tailwind className，导致 `Unknown Action`；修复后全程可用 |
| Gemini | `timeout` | 页面恢复后抓到旧会话回复 / 无回复；是 provider 会话恢复问题，未进入协议解析 |

### 全动作真机复现（Grok，两轮）

用 `.workbuddy/instrumented-action-run.js` 覆盖 `书 / 阅分页 / 多组改 / 行 / 摄 / 答 / 毕`：

| 轮次 | 结果 | 原始动作序列 | 落盘产物 |
|---|---|---|---|
| 第 1 轮 | `completed` 13 步 | `阅 .` → `书` → `阅 0/4/8/12/16` → `改` → `行` → `摄` → `答` → `毕` | `notes.txt` = `ONE\n\ntwo\n\nTHREE\n\n`，截图 1.9 MB |
| 第 2 轮（复现） | `completed` 12 步 | 同上，少了开场的 `阅 .` | 同上，截图 1.9 MB |

两轮均无解析错误、无纠错提示，`答` 混用 `答｜「…」` / `答「…」` 两种写法，解析器都兼容。

GLM 修复（与协议无关，顺带修掉）：
- `providers/dom/glm-message.js`：剥掉正文开头的裸「思考过程」标签。
- `providers/glm.js`：把 Tailwind className 串纳入 `isStyleNoise`，不再当正文返回。
- `test/unit/test-glm-message.js`：新增 3 条断言，33/33 通过。

`npm run test:unit` 全绿（EXIT=0），XML/JSON 默认行为未变。

### 技能（Skill）适配

技能内容本身刻意保持协议无关（只讲“怎么做”，不规定动作语法）；但注入的**技能段文案**原先写死 `read / nextOffset`，会带偏文言会话。现已按协议渲染：

- XML / JSON：文案逐字不变，避免影响默认行为。
- 文言：标题改「可用之术」，说明用 `阅` / 续 `阅`，并显式给出英文动作名映射：
  `read / write / edit / exec / answer / done` → `阅 / 书 / 改 / 行 / 答 / 毕`。
- 技能清单里的「路径 / 用途」在文言下改「所在 / 用」。

真机验证（DeepSeek）：工作区技能文档里故意放了 `<read/>` 和 `{"action":"read"}` 旧示例，任务要求“用该技能核对 a.txt”。模型原始回复：

```
阅 .agent/skills/check.md
阅 a.txt
答「a.txt 内容逐字为：\nalpha\nbeta\n…」
毕
```

4 步 `completed`，未泄漏 XML/JSON 动作。验证脚本 `.workbuddy/instrumented-skill-wenyan-run.js`，日志 `.workbuddy/live-skill-wenyan.log`。

### 历史验证（优化前的 `｜` 写法）

新会话下完整闭环 `completed`、3 步、0 解析错误：`阅｜a.js` → `答｜「a 的最终值为 1」` → `毕`。

另一轮（复用会话，前 3 步被上一段 JSON 会话残留污染）里，从第 4 步起模型正确输出 `改｜a.js｜「const a = 1;」｜「const a = 2;」`，edit 精确匹配落盘（`a=2` 成功）；该轮因污染浪费步数触发墙钟 timeout，非协议缺陷。

## 如何运行

### 图形界面切换

设置面板 →「Agent配置」→「动作协议」新增第三个按钮 **文言（实验）**，与 XML / JSON 并列。
保存后写入 `~/.xml-agent/webui-agent-config.json` 的 `agent.protocol = "wenyan"`，对新任务生效。
默认值仍是 `xml`；设置项标注“实验”，不影响既有会话。

也可用环境变量临时指定：`AGENT_ACTION_PROTOCOL=wenyan`，CLI 可用 `--protocol wenyan`。

```bash
node agent.js --provider qwen --protocol wenyan --workspace <dir> "用 阅 看 a.js，然后 答 报告，最后 毕"
node test/wenyan-token-benchmark.js   # 打印节省对比
```

## 结论

二次优化后，文言协议在同等信息量下：输出侧动作省约 **44%（vs XML）/ 59%（vs JSON）**，首轮提示词省约 **46% / 70%**，每轮成功回贴省约 **61% / 60%**；按 10 步任务累计，整体省约 **54% / 64%**。紧凑写法已通过 Qwen 真机原始回复验证，4 步闭环 `completed`。它证明"压缩语法骨架 + 压缩重复措辞"这条路径确实有效；是否值得投入正式化，需权衡模型遵循度与兼容成本。当前保持为实验分支，不入正规流程。
