# dsh-lamp

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话活动映射成
codex-lamp 的状态，让 Moonside Halo 随 agent 状态亮灯。

`codex-lamp` 本身依赖 Codex 专属的 `/hooks` 机制，无法直接用在 DSH 上。但它的灯控部分是
Codex 无关的——daemon 只认状态输入。`dsh-lamp` 就是一个 DSH 宿主插件，充当「DSH 会话事件 → 灯控后端」的桥：

```
DSH host 会话事件 (session/event)
  -> dsh-lamp (Cordis host plugin)
       -> 状态机 (working / input / idle / off)
       -> 后端:
            ksanaka   → 写入已安装的 ksanaka codex-lamp StateStore，其 BLE daemon 驱动灯（默认）
            state-file → 原子写状态文件（默认 /tmp/dsh_lamp_state），供任何消费者读取
```

## 后端选择（`backend` 配置）

| 后端 | 输出 | 何时用 |
| --- | --- | --- |
| `auto`（默认） | 检测到 ksanaka 安装（`~/Library/Application Support/CodexLamp/config.json`）就用 ksanaka，否则 state-file | 大多数机器 |
| `ksanaka` | 通过 venv python 调用已装的 `codex_lamp.state.StateStore`（`update/remove` 会话记录，daemon 按 `config.json` 的 priority 聚合） | 已装 [ksanaka/codex-lamp](https://github.com/ksanaka/codex-lamp) |
| `state-file` | 原子写状态文件（默认 `/tmp/dsh_lamp_state`，一行 `working\|idle\|input\|off`） | 不装任何 codex-lamp，只想要状态输出 |
| `none` | 只记日志 | 调试/预览 |

ksanaka 后端复用你已装的 daemon 与 BLE 连接（`<home>/venv/bin/python3 -m codex_lamp.daemon`），
不重新实现锁与聚合——`python/ksanaka_bridge.py` 只是把会话状态喂给它的 StateStore。

## 没有 codex-lamp 也能用吗？

**能。** `dsh-lamp` 本身不依赖任何 codex-lamp 安装——它只负责「把 DSH 会话事件变成状态」，
灯控那半边（daemon + BLE + Moonside 灯）才是 codex-lamp 的事。两种用法：

| 场景 | 行为 | 你需要做什么 |
| --- | --- | --- |
| **不装 codex-lamp** | `auto` 探测不到 ksanaka 安装，自动退回 `state-file` 后端，把状态写进 `/tmp/dsh_lamp_state` | 什么都不用装。状态文件照样产生，可被任何程序消费：`tail -f /tmp/dsh_lamp_state`、喂给自定义脚本、或者以后再加灯 |
| **点亮 Moonside 灯** | 装 [ksanaka/codex-lamp](https://github.com/ksanaka/codex-lamp)，`auto` 探测到后走 ksanaka 后端，DSH 与 Codex 共用一盏灯 | 按 codex-lamp 的安装说明装好即可 |

补充说明：

- `auto` 探测的是 `~/Library/Application Support/CodexLamp/`（macOS 默认）下是否存在
  `config.json` 或 `sessions/`。Linux 用户没有这个目录，会自然落到 state-file 后端，
  也可用 `CODEX_LAMP_HOME` 或 `ksanaka.home` 配置指定位置。
- 想要某条路径，也可以显式 `backend: ksanaka | state-file | none`，不依赖探测。
- 无论哪档，插件都 fail-open：灯控半边缺失/失败绝不影响 DSH 本身。

## 状态映射

| DSH 会话事件 | 灯状态 | 说明 |
| --- | --- | --- |
| `session/created`（打开/恢复会话） | `idle` | 对应 codex-lamp 的 SessionStart |
| `agent/inbox/spliced`（用户提交提示词） | `working` | 只认 `source.kind === "user"` 的插入 |
| `turn/start` / `step/start` | `working` | agent 开始干活 |
| `tool/call`（普通工具） | `working` | 工具执行中 |
| `tool/call`（`ask_user_question`） | `input` | 在等用户回答 |
| `approval/asked` | `input` | 等待审批（对应 Codex 的 PermissionRequest） |
| `approval/decided` | `working` | 审批通过，回合继续 |
| `command/run`（斜杠命令） | `working` | 用户驱动的命令 |
| `turn/end` | `idle` | 回合结束（有 800ms 防抖，避免闪烁） |
| `session/end-seed` / `session/disposed` | 移除跟踪 | 全部移除后 → `off` |

多会话并发时按优先级聚合：`input > working > idle > off`（与 codex-lamp 一致）。
超过 `staleMs`（默认 30 分钟）没有事件的会话会被清出跟踪 → 灯灭。

## 安装

### 1. 把插件装进 web profile

从 GitHub 安装：

```bash
dsh plugin --profile web add github:ksanaka/dsh-lamp
```

或本地目录安装（开发时）：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-lamp
```

### 2. 在 profile 的 patch 层注册插件

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加：

```yaml
- insert:
    - id: lamp
      name: dsh-lamp
      config:
        # state-file 后端的状态文件路径（默认 $DSH_LAMP_STATE_FILE 或 /tmp/dsh_lamp_state）
        stateFile: /tmp/dsh_lamp_state
        # 等待审批/提问时点紫色（input），忙碌时 BEAT2（working）……
        # 其余配置见下方「配置项」
```

### 3. 准备灯控 daemon

- **ksanaka（本机默认路径）**：什么都不用做——插件自动找到
  `~/Library/Application Support/CodexLamp/venv/bin/python3`，按需拉起
  `python -m codex_lamp.daemon` 驱动你的灯。可配 `ksanaka.home` / `ksanaka.python` 覆盖。
- **只用 state-file**：不需要 daemon，状态文件照写，用任何方式消费它。

### 4. 重启

```bash
# 停掉当前 dsh web，再重新启动
dsh web
```

重启后打开任意会话、发一条消息，然后：

```bash
# ksanaka 后端（本机默认）：看聚合状态与 daemon 日志
cat ~/Library/Application\ Support/CodexLamp/effective_state.json
tail -f ~/Library/Application\ Support/CodexLamp/logs/daemon.log

# state-file 后端：
cat /tmp/dsh_lamp_state
```

## 配置项

在 `cordis.patch.yml` 的 `config:` 下可配：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `auto` | `auto` / `ksanaka` / `state-file` / `none` |
| `priority` | `[input, working, idle, off]` | 聚合优先级，越靠前越优先 |
| `idleDelayMs` | `800` | working→idle 的防抖毫秒数（新事件会取消） |
| `staleMs` | `1800000` | 会话静默多久后清出跟踪（30 分钟） |
| `sweepMs` | `60000` | 清理扫描间隔 |
| `dryRun` | `false` | 只打印状态转换，不写任何后端 |
| `stateFile` | `$DSH_LAMP_STATE_FILE` 或 `/tmp/dsh_lamp_state` | 仅 state-file 后端 |
| `ksanaka.home` | `$CODEX_LAMP_HOME` 或 `~/Library/Application Support/CodexLamp` | ksanaka 数据根 |
| `ksanaka.python` | `<home>/venv/bin/python3` | 装有 `codex_lamp` 的解释器 |

示例（强制 ksanaka）：

```yaml
- insert:
    - id: lamp
      name: dsh-lamp
      config:
        backend: ksanaka
        idleDelayMs: 1200
        ksanaka:
          home: /Users/me/Library/Application Support/CodexLamp
```

## 工作原理 / 设计说明

- 监听宿主侧 `session/event` 事件（与 `dsh-session-title`、`dsh-session-telemetry-otel` 同一机制），
  因此**无需改动 DSH 本体**，也**不依赖浏览器是否打开**（事件由宿主进程产生）。
- 事件只在 `Session.append()` 时发出，恢复/回放历史会话不会产生事件风暴。
- 全部失败都 fail-open：后端写不进、daemon 找不到、daemon 崩溃，都不会影响 DSH。
- ksanaka 后端不重实现锁与聚合：`python/ksanaka_bridge.py` 用你已装的 venv python 直接调
  `codex_lamp.state.StateStore`（fcntl 锁、优先级聚合、stale 清理全是原版行为），
  并在 daemon 未运行时用 `python -m codex_lamp.daemon` 拉起它。
- `lib/state.js` 是纯函数状态机（可单测）；`lib/backend.js` 统一 ksanaka/state-file/none 后端；
  `lib/ksanaka.js` 负责桥接与 daemon 生命周期；`lib/index.js` 是 Cordis 插件壳。

## 验证

### 不用重启，立即可以做的

**1. 单元 + 集成测试**（状态机与插件管线，21 项）：

```bash
cd dsh-lamp
node --test
```

**2. 可视化 demo**——用真实插件逻辑跑一段脚本化对话，实时写出可观测状态，
还能直接驱动真灯（ksanaka 后端 + 已装的 daemon + 通电的 MOONSIDE 灯）：

```bash
# ksanaka（本机默认）：驱动你的真灯，灯会按时间线亮 working→input→idle→off
# demo 会先等待 daemon 连上灯（--hold 默认 9s，冷启动的 daemon 需要约 6s 扫描+连接）
node scripts/demo.mjs --backend ksanaka

# state-file：只验证状态文件管线
node scripts/demo.mjs --backend state-file --state-file /tmp/dsh_lamp_demo_state
```

输出示例：

```
✓ 打开会话 (session/created)                       →  idle
✓ 用户提交提示词 (agent/inbox/spliced)             →  working
✓ 等待审批 (approval/asked)                        →  input
✓ 审批通过 (approval/decided)                      →  working
✓ 关闭 s2 (session/end-seed) → off                 →  off
```

> 提示：如果你从终端跑但灯没亮，看 `~/Library/Application Support/CodexLamp/logs/daemon.log`——
> 常见原因是系统蓝牙没开、或终端缺少蓝牙权限（"Bluetooth device is turned off"）。

**3. 确认插件已注册进 profile**：

```bash
dsh --profile web --dump-config | grep -A3 'id: lamp'
```

### 重启 dsh web 后做的（真实宿主驱动）

```bash
# 1. 重启
#    停掉当前 dsh web，再运行：dsh web

# 2. 观察宿主日志出现 dsh-lamp 的状态日志
#    （日志文件位置见 ~/.dsh/logs/，grep dsh-lamp）

# 3. 打开一个会话 → 发消息 → 等它问你要审批
cat ~/Library/Application\ Support/CodexLamp/effective_state.json   # ksanaka
# 或（state-file）: cat /tmp/dsh_lamp_state
```

| 你的操作 | 预期状态 |
| --- | --- |
| 打开会话（还没发消息） | `idle` |
| 发一条消息，agent 开始干活 | `working` |
| agent 触发审批/向你提问 | `input` |
| 回合结束 | `idle` |
| 关闭会话 / 静默 30 分钟 | `off` |

有灯的话同时 `tail -f ~/Library/Application\ Support/CodexLamp/logs/daemon.log` 看 daemon 收发指令。

## 测试

```bash
cd dsh-lamp
node --test
```

## 卸载

```bash
dsh plugin --profile web remove dsh-lamp
# 并从 ~/.dsh/profiles/web/cordis.patch.yml 删掉 lamp 条目
```

## 限制

- 灯控本身是 macOS + Moonside Halo + BLE（`bleak`）——这是 codex-lamp 的边界，与本插件无关。
- ksanaka 后端复用你已装的 codex-lamp 安装与 daemon；它原本是给 Codex 用的，
  本插件与 Codex 互不干扰（各自的会话记录都进同一个 StateStore，优先级聚合天然合并）。
- `input` 语义映射的是 DSH 的审批/提问（`approval/asked`、`ask_user_question`），
  与 Codex 的 `PermissionRequest` 等价，但事件名不同。
- 需要重启 `dsh web` 才能加载插件。
