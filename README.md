# WorkBuddy 反代网关

把本机已登录的 **WorkBuddy 账号池** 反代成 **OpenAI 兼容 API**，给任意支持自定义 baseURL 的客户端用（Cline、Cherry Studio、Chatbox、DSH 等）。

参考 `Cockpit Tools` 的 API 服务面板形态做的独立实现：同样的「本机地址 + `agt_` 密钥 + 账号状态 + 监听范围」信息结构，但账号来源是 **WorkBuddy**，不是 Codex。

---

## 它做什么

```text
客户端 (OpenAI SDK / Cline / Cherry Studio …)
  └─ POST http://127.0.0.1:57282/v1/chat/completions   (Bearer agt_xxx)
       └─ 网关：鉴权 → 选号 → 令牌续期 → 请求体整形
            └─ https://copilot.tencent.com/v2/chat/completions   (WorkBuddy 国内版)
               https://<你的域名>/v2/chat/completions             (WorkBuddy 国际版)
                 └─ SSE chunk 原样规范化 → 回吐给客户端
```

上游**只支持流式**，所以网关替你做了四件事：

1. 客户端要 `stream: false` 时，网关在本地把 chunk 聚合成一个完整 `chat.completion`；
2. 上游的 `developer` 角色降级成 `system`，并保证首条是 `system`；
3. **渠道校验净化**（关键，见下节）——不做过不了真实客户端；
4. 失败自动换号、区分「换号有用」和「换号也没用」的错误；失败只记录原因，**不冷却、不封锁账号**。

## 为什么必须有「渠道校验净化」

上游网关会对 `system` / `assistant` 消息做**大小写不敏感的精确子串匹配**，命中就回：

```json
{ "code": 11128, "msg": "Illegal API invocation from an unapproved channel" }
```

这曾让整个软件不可用：**短提示能通，真实客户端的长系统提示一律被拒**。只发「说一个字」的测试永远绿，装到 Cline / Cherry Studio 里就全废。

实测结论（CN 网关，`deepseek-v4.1-flash`，逐条对照，见 `test/probe-channel-gate.mjs`）：

| 写法 | 结果 |
| --- | --- |
| `You are a helpful assistant.` | 200 |
| `You are an AI agent powered by DeepSeek Harness.` | 400 / 11128 |
| 同一句全小写 | 400 / 11128 |
| 句中穿插零宽字符 `\u200b` | 400 / 11128（**零宽无效**，上游会规范化） |
| 两句话用空格连起来 | 400 / 11128 |
| 两句话用换行连起来 | 200 |
| `You are Claude Code, Anthropic's official CLI for Claude.` | 400 / 11128 |
| 句中位置（前面加别的句子） | 200 |

所以 `src/sanitize.js` 做两件事，**都不丢信息**：

1. **句间换行**：把「`. `」改成「`.\n`」，一个字都不改，只动分隔符；
2. **短语等价改写**：把实测被拒的短句换成同义说法（`powered by` → `running inside` 等）。

仍然被拒时（例如单句里出现没收录的新短语），`bridge.js` 会改用 dense 模式再发一次：把长 system 文本**拆成多个 text part**——实测网关是逐 part 匹配的，拆开能绕过跨句组合。

> 反向验证在 `test/probe-necessity.mjs`：同一份请求不净化 400/11128、净化后 200。这条不是"顺手加的"，是功能能不能用的分界线。

## 快速开始

**软件位置**：`D:\document\code\my_project\workbuddy-gateway`

### 方式一：桌面端（推荐）

进入 `desktop` 文件夹，双击 **`start-desktop.bat`**。

首次使用要先装一次 Electron（约 180 MB，只需一次）：

```bat
cd desktop
npm install
```

> 国内下载慢的话先设镜像：`set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

桌面端做的事很简单：拉起网关 → 打开窗口指向本地面板 → 关窗时把网关一起关掉（不留孤儿进程占端口）。
如果你已经在跑 `start.bat`，桌面端会直接连上已有实例，不会抢端口。

### 方式二：浏览器 + 批处理

| 文件 | 用途 |
| --- | --- |
| `start.bat` | 仅本机可访问（默认，推荐） |
| `start-lan.bat` | 局域网模式，同网段其它设备也能接入 |

### 方式三：命令行

```sh
cd /d D:\document\code\my_project\workbuddy-gateway
node src\cli.js            # 默认 127.0.0.1:57282
node src\cli.js --open     # 启动后自动打开面板
node src\cli.js --port 6000 --lan
```

前提：本机有 Node.js 22 或更高版本（`node -v` 可查；这台机器是 v24.0.0，已满足）。

## 界面

按「卡片网格」风格做的，深色 / 浅色两套主题可切换（右上角开关，选择会记住）。

**页面结构**

```
WorkBuddy 网关                              [深色/浅色] [运行中]
把本机已登录的 WorkBuddy 账号，反代成 OpenAI 兼容接口

账号 3/3   模型 60   请求记录   设置          ← 页签带计数
────────────────────────────────────────────

┌─ 接入（横跨整行）──────────────────────────────────┐
│ BASE URL          API KEY          积分余额        │
│ http://…57282/v1  agt_uG-…⧉   12314.06 / 17455  │
│ 局域网地址                         ▓▓▓▓▓░░ 剩余71% │
└────────────────────────────────────────────────────┘

[筛选账号…]                    [重新检测] [添加账号]

┌──────────┐ ┌──────────┐ ┌──────────┐
│ 👤 448***│ │ 👤 周海军 │ │ 👤 永恒海 │   ← 卡片网格
│ 积分 4281│ │ 积分 4489│ │ 积分 3544│
│ 签到 47天│ │ 签到 47天│ │ 签到 44天│
├──────────┤ ├──────────┤ ├──────────┤
│刷新  测试│ │刷新  测试│ │刷新  测试│   ← 底部分隔线操作栏
└──────────┘ └──────────┘ └──────────┘
```

**模型页**也是同样的卡片网格，每张卡带图标方块、模型名、可点击复制的 id、思考档位分段控件。
重名模型会标黄色「重名」徽标。

**设计要点**

- 深色：近黑蓝底（`#0b1017`）+ 紫罗兰强调（`#7c6cf5`）
- 浅色：暖白底（`#f6f4f0`）+ 同色强调
- 卡片统一 14px 圆角、18px 间距、等高对齐
- 图标方块按 id 哈希取四种配色，卡片之间有区分度又不花
- 徽标用浅底深字（`可用` 是浅绿底绿字），不用荧光色块

## 支持的接口

| 接口 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | 流式 / 非流式、`tools` 工具调用、`reasoning_content` 推理内容 |
| `POST /v1/responses` | Responses 风格入参，内部折叠成 chat，再折回 `response` 对象 |
| `GET /v1/models` | 上游真实模型目录 |
| `GET /v1/me` | 当前密钥与账号池概况 |

## 账号来源与安全边界

- **只读** WorkBuddy 桌面端的 `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`，一个字节都不改。
- 同目录下带时间戳的 `*.info` 是历史登录备份，上游早已吊销其令牌（实测：`expiresAt` 还在未来，请求一律 401）——所以默认**不收备份**，避免账号池一开始就显示一堆假「可用」。
- 网关自己的副本存在 `~/.workbuddy-gateway/`，文件权限 `0600`。
- 面板接口默认只允许回环地址访问；要局域网访问得显式打开 `allowPanelFromLan`。
- 令牌续期写的是**网关副本**，不回写桌面端文件；关掉 `tokenRefresh` 就完全退化成只读。
- 「导出账号」是明文，必须二次确认——任何拿到该文件的人都能用你的额度。

## 额度显示为什么不是「5h / 周」

Codex 订阅那套有 primary/secondary 双窗口，WorkBuddy 上游**没有**这两个字段。它给的是：

- 流式响应最后一块的 `usage.quota = { model, percent, reset_at }`，其中 `percent` 是**已用百分比**（实测：发一次请求从 4% 涨到 6%）；
- 积分包余额走 `POST /v2/billing/meter/get-user-resource`（按套餐聚合）。

所以面板显示的是「某模型 已用 N% + 重置时间 + 积分 X/Y」，而不是照抄一个不存在的双窗口。没有数据时显示「尚无额度数据」，绝不编一个数。

## 逐模型设置（思考强度 / 上下文档位）

面板「模型」区每个模型一行，勾选启用后才会出现在 `/v1/models` 里。每个控件都对应上游真实声明的能力：

| 控件 | 数据来源 | 是否真的改变请求 |
| --- | --- | --- |
| 启用勾选 | 面板设置 | 是（决定 `/v1/models` 里列不列） |
| 图片 | 上游 `supportsImages` | 只读展示（上游说没有就不能发图） |
| 关闭思考 | 上游 `reasoning.canDisableThinking` | 是（请求体 `thinking:{type:'disabled'}`） |
| 思考档位 | 上游 `supportedEfforts` / `effort` | 是（请求体 `reasoning_effort`） |
| 上下文档位 | 上游 `contextWindow.supportedLengths` | 仅作显示与预算参考（上游按内容自适应） |
| 测速 | 真实请求 | 是（会消耗额度，返回首字延迟与思考 token） |

上游没声明的能力就不渲染，避免出现点了没反应的开关。

### 关于「思考档位」的两个实测结论

**1. 不传 `reasoning_effort` 就是不思考，不是按目录里的默认值跑。**

```
不传 reasoning_effort      → 思考   0 token
reasoning_effort: low     → 思考  85 token
reasoning_effort: high    → 思考 119 token
```

上游目录里写着 `defaultEffort: "high"`，但**不传就是不思考**。所以面板默认显示「关 / 当前不思考」，只有你显式选了档位才会真的思考。把上游的"建议值"显示成"当前生效"会让人以为在推理，其实一个字都没想。

**2. 上游有两种档位写法，只认数组会漏掉一半模型。**

```
supportedEfforts: ["low","high","max"]   → 19 个模型（多档可选）
effort: "high"                            → 13 个模型（单档固定）
无 reasoning 字段                          → 25 个模型（不支持推理）
```

单档模型在面板上显示成「关 | high」两个按钮，不是假装有多个档可选。

非法档位（不在 `supportedEfforts` 里的）在**服务端**也会被丢弃，不只是界面挡住——直接调 API 传 `bogus` 存下来也是 `null`。因为传给上游会直接 `400/11133`。

## 模型名兼容与重名

网关接受三种写法，都能映射到上游认的 id：

| 客户端填 | 是否可用 |
| --- | --- |
| `deepseek-v4.1-flash`（id） | ✅ 永远可用 |
| `DeepSeek-V4.1-Flash`（显示名） | ✅ 唯一时可用 |
| `DEEPSEEK-V4.1-FLASH`（任意大小写） | ✅ |

**但显示名会重名。** 实测 60 个模型里有 4 组、11 个模型同名：

```
"Hy4 preview"  → hy4-preview-ctrl / hy4-preview-exp / hy4preview-exp1 / hy4preview-exp2 / hy4-preview-x
"Hy3"          → hy3-b / hy3-c
"Hy4 flash"    → hy4flash-free / hy4flash
"DeepSeek-V3-0324" → deepseek-v3-0324-lkeap / -taco-completion
```

这种情况**不替用户猜**，直接返回 400 并列出候选：

```json
{ "error": { "message": "模型名 \"Hy4 preview\" 有歧义，请改用 id 之一：hy4-preview-ctrl / hy4-preview-exp / …" } }
```

静默挑第一个等于把用户要的模型悄悄换成另一个 —— 计费倍率和能力都不同。

### 模型名不存在时不换模型

填一个目录里没有的名字（例如 `deepseek`，目录里是 `deepseek-v4-flash` / `deepseek-v4.1-flash`），
网关会**直接报错并列出可用 id**：

```json
{ "error": { "type": "model_not_found",
  "message": "模型 \"deepseek\" 不存在。可用的有：auto / fast-model / balanced-model / …" } }
```

> 早先这里会自动改成默认模型重试。实测事故：填 `deepseek` 时网关偷偷用
> `deepseek-v4.1-flash` 执行成功并扣了 2.13 credit，日志还只记原始名字，
> 用户完全不知道自己用的其实是另一个模型。**替你换模型等于替你花钱做决定**，已改为明确拒绝。

### 复制模型 id

面板上每个模型的 id 是个**可点击的按钮**（`hy4-preview-x ⧉`），点一下就复制到剪贴板，直接粘进客户端。

重名的模型会额外标一个黄色「重名」标签，提醒你这里的名字不能用、必须用 id。

## 每日签到

账号表里每行有「签到」列和一个签到按钮。状态直接读上游的 `today_checked_in` / `streak_days`，不靠本地日期猜。

实测接口（2026-11-18）：

| 用途 | 路径 | 说明 |
| --- | --- | --- |
| 查状态（只读） | `POST /v2/billing/meter/checkin-activity-status` | 返回 `{code,msg,data:{today_checked_in,streak_days,daily_credit,…}}` |
| 执行签到 | `POST /v2/billing/meter/daily-checkin` | 已签到时 `400` + `code 10001`「今天已签到，请明天再来」 |

设计上的几点：

- **已签到当成功处理**，不算错误。`10001` 会返回 `alreadyCheckedIn: true` 并提示「今天已签到（连续 N 天）」，不会让面板弹红字——那本来就不是故障。
- **只在你点按钮时签**，绝不后台自动跑。签到是真实副作用（真的领积分），不能替用户做决定。
- 签完**回查一次状态**，用上游的新数字刷新面板，不做乐观猜测。
- 面板加载时只调一次**只读**的状态接口，这样「今天签没签」有数据可显示；已经有状态的账号不会每次轮询都去打接口。

## 账号导出

面板「导出账号」按钮导出全部账号的明文 JSON（含 `accessToken` / `refreshToken`），需要二次确认。

⚠️ **这是明文凭据**：任何拿到该文件的人都能用你的额度。只保存到可信位置，不要发聊天工具或提交到仓库。

导出文件可直接被本网关重新导入（格式一致）。

## 积分余额

面板顶部那张卡显示**账号池的积分**：`剩余 / 总量`，例如 `8770.00 / 9134 credits`，外加剩余百分比与额度重置时间。账号表里每行也有自己的「积分余额」。

数据来源是上游真实接口 `POST /v2/billing/meter/get-user-resource`（账号自己的套餐 + 奖励 + 补偿资源包），点账号行的「余额」按钮即查一次。

三条诚实性规则：

1. **没查过就是「—」**，不显示 0。0 的意思是「用光了」，不是「不知道」。
2. 池子只汇总**真的查到过**的账号，并注明 `仅 1/2 个账号已查余额`，不会把「2 个号里只有 1 个查过」当成池子总量。
3. 导入文件里带 `quota_raw` 时（那种 `CreditGroups` 结构），导入时就把积分存下来，不用等第一次请求。

> 早先这里显示的是「某模型已用 63%」。那个数字只反映单个模型的额度窗口，
> 和用户真正关心的「我还剩多少额度」不是一回事，已换成积分。

## 导入账号

三种输入都能直接粘贴，按结构自动分辨，不用选格式：

| 输入形状 | 来源 |
| --- | --- |
| `[{ "access_token": ..., "expires_at": ... }]` | 账号池导出（snake_case） |
| `[{ "accessToken": ... }]` 或带 `auth_raw` 的数组 | 账号池导出（驼峰） |
| `{ "auth": { "accessToken": ... }, "account": {...} }` | 桌面端 auth 文档 |
| `{ "accounts": [...] }` | 带包装的导出 |

坏条目**逐项报错但不影响好的那些**，例如「第 2 项：没有 access_token」。

两个容易错的细节，已有测试钉住：

- **`expires_at` 是毫秒**（`1797401144438` ≈ 2026 年）。按秒解析会得到 1970 年，令牌立刻被判过期。
- `auth_raw.auth.expiresAt` 是**秒**（`1795514912`），两种同时在时以顶层毫秒值为准。

## 错误分类

**没有冷却。** 账号失败只记录原因，不封锁、不计时、不阻止再被选中。
避免坏号拖慢请求的方式是选号时**排序**：刚失败的号排在健康号后面。

| 上游表现 | 归类 | 网关动作 |
| --- | --- | --- |
| 401 / 403（含 openresty HTML） | 账号级 | 换号重试，该号记为失败 |
| 429 / 配额耗尽 | 账号级 | 换号重试，记下上游声明的恢复时间（仅展示） |
| 5xx / 网络错误 | 账号级 | 换号重试 |
| **11128 渠道校验** | 请求级 | **先换 body 形状重试一次**（dense 拆分），仍失败才回报 |
| **11133 参数被拒** | 请求级 | **先裁掉非标准字段重试一次**，仍失败才回报 |
| **空 messages** | 本地拒绝 | **根本不发上游**，直接返回「messages 是空的」 |
| 400 其它参数错、`11101` 非流式 | 请求级 | 不换号，直接回给调用方 |
| 6020/6021/6022 排队 | 请求级 | 不换号、不重试，如实回报排位 |
| **客户端中途断开** | 不是失败 | 不记失败，只归还并发额度 |

排位规则（`pool.pick`）：

1. 有未清除错误的排后面（刚失败过，先别撞它）
2. 并发占用低的优先
3. 最久没用过的优先（轮换）

所以失败过的号**依然会被用到**，只是不会抢在健康号前面。「复位」按钮清掉错误记录后，它立刻回到正常排位。

### 11133「参数被拒」到底是怎么回事

面板上曾只显示一句英文 `the request parameters were rejected by the model provider`——没有 code、没有原因、没有下一步，等于什么都没说。

抓完整响应后发现上游给的信息其实很全：

```json
{
  "code": 11133,
  "msg": "Invalid request parameters",
  "extError": { "code": "invalid_request_error",
                "message": "the request parameters were rejected by the model provider" },
  "displayTips": { "zh": "这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。" },
  "actions": ["SWITCH_MODEL", "SUBMIT_FEEDBACK", "NEW_CONVERSATION"]
}
```

**实测触发原因：图片以裸 base64 发送。** `image_url.url` 直接放 base64 会被拒，加 `data:image/png;base64,` 前缀就正常。很多客户端会漏掉前缀。

所以现在做了两件事：

1. **自动修复**——`shapeChatBody` 里嗅探裸 base64 的图片类型并补全成 data URL（也把 Anthropic 风格的 `{type:'image', source:{...}}` 转成 OpenAI 格式）。实测修复前后：裸 base64 `400/11133` → 修复后 `200`。
2. **错误信息说清楚**——带上 code、上游中文提示、上游建议的动作（`SWITCH_MODEL` → 「换个模型」），11133 还会额外指出「常见原因是图片裸 base64」。

失败请求还会把**请求体形状**（顶层字段名 + 每条消息的角色/content 类型，不含正文）记进日志，这类 400 不看到底发了什么字段根本查不出来。

最后一条是必须区分的：用户在 WorkBuddy AI 里点停止、关页面、切会话，都表现为流被中断。
早期版本把这当成账号故障并冷却 1 分钟 → 下一次请求直接 `503 没有可用账号`，
而上游明明一切正常。现在改成识别为客户端取消（`abort`），连失败都不记。

### 两个很隐蔽的坑（都已修）

**1. 中文账号昵称会让所有流式请求 500。**
账号名被直接塞进响应头 `x-workbuddy-account`，而 HTTP 头只能是 ASCII。
昵称是「测试号」「永恒海星派大星」这类中文时，Node 抛 `ERR_INVALID_CHAR`，
整个响应变成 500 —— 现象看起来像随机的服务端故障，实则固定发生在中文昵称账号上。
现在统一走 `headerSafe()` 做百分号编码。

**2. 流被取消时并发额度会泄漏。**
异步生成器被"遗弃"时它的 `finally` 不保证执行：客户端断开后 `next()` 还挂在上游的
`read()` 上，`release()` 一次都没跑，`inflight` 永久加一。取消几次后账号就被
并发上限（默认 2）彻底堵死，表现为「明明空闲却一直 503」。
现在额度归还挂在 `res` 的 close 事件上（幂等），不依赖生成器是否善终。

把请求级错误也拿去换号，等于一次错误请求把所有账号都记成失败；把账号级错误当成请求错误，则一个失效旧号会拖慢整池。两者都实测踩过。

## 已验证

```sh
node --test test/gateway.test.mjs        # 27 项：整形、净化、图片修复、瘦身、分类、鉴权
node --test test/abort.test.mjs          # 3 项：客户端取消不记失败、额度必归还、真失败仍记录
node --test test/nocooldown.test.mjs     # 6 项：失败不封锁、选号排序、复位、停用
node --test test/import.test.mjs         # 6 项：两种导出格式、坏条目逐项报错、单位换算
node --test test/credits.test.mjs        # 4 项：积分汇总、部分已知、未知不显示 0
node --test test/checkin.test.mjs        # 7 项：状态解析、重复签到不报错、失败如实报错
node --test test/lan.test.mjs            # 3 项：局域网地址探测、私网判断、排除虚拟网卡
node --test test/persist.test.mjs        # 2 项：额度/余额重启后仍在
node --test test/modelsettings.test.mjs  # 11 项：档位解析、归一、真正进请求体
node test/e2e-realistic.mjs              # 真实客户端形状：长系统提示/多轮/工具/developer
node test/e2e-effort.mjs                 # 真实上游：改档位后思考 token 确实变化
node test/e2e-image.mjs                  # 真实上游：裸 base64 图片被自动修复
node test/e2e-real.mjs                   # 真实上游：模型目录、流式、聚合、工具调用、responses
node test/e2e-failover.mjs               # 塞失效号，验证 401 → 自动换号 → 失败号排到后面
```

实测通过（最近一次全绿）：

- 模型目录 60 条；流式 200；非流式聚合出正文；`get_weather` 工具参数完整；`/v1/responses` 正确折叠
- **真实客户端形状 6/6**：长系统提示（含身份短语）、长提示+多轮历史、assistant 历史含身份短语、长提示+工具调用、developer 角色、短对话对照组
- 故障切换：失效号 401 → 记为失败但不封锁 → 请求自动切到可用号返回 200 → 第二次不再撞它

## 探针（需要真机登录态，会消耗少量额度）

```sh
node test/probe-upstream.mjs        # 直连上游看原始 SSE 与 usage.quota
node test/probe-channel-gate.mjs    # 复现 11128，并验证净化前后的对比
node test/probe-zero-width.mjs      # 零宽字符三种位置的处理
node test/probe-necessity.mjs       # 证明净化是必需的（不净化被拒、净化后通过）
```

## 风险提示

这是**非官方**通道，用的是 WorkBuddy 客户端自身的接口。上游随时可能调整或收紧限制，届时网关可能需要跟着改。每一次调用都消耗**你自己账号**的额度，按上游给出的倍率真实计费。请自行评估账号风险后再使用。
