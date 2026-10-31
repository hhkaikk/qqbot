# 仓库目录地图

| 目录/文件 | 作用 |
| --- | --- |
| src/bridge.js | QQ 收发、会话和调度协调；HTTP 服务统一入口 |
| src/management-routes.js | 白名单、管理员与模型档位管理 |
| src/dashboard.js、operations-routes.js | 工作台投影、预算与诊断接口 |
| src/token-ledger.js、spend-guard.js | 用量账本与自动聊天保护 |
| src/member-memory.js、message-relations.js | 稳定成员身份和明确引用关系 |
| src/speech-*.js | 语音收听、合成、质量及配置 |
| public/ | 原生 HTML/CSS/JavaScript 页面与头像资源 |
| dsh/agent-presets/ | QQ 预设的源文件 |
| plugins/ | 预设 bundle 与工具权限守卫 |
| deploy/ | Linux/systemd、NapCat、恢复服务和 Nginx 模板 |
| scripts/ | 安装、补丁、测试与运维工具 |
| roles/ | 示例人格卡 |
| docs/ | 使用与维护文档 |
| config.example.json | 配置模板；实际 config.json 不进入 Git |
| state/、audio/ | 本地生成的私有数据与音频，不随仓库提供 |

scripts/test-*.mjs 主要为回归检查；scripts/test-dsh-*.mjs、带 live 的脚本可能需要运行中的外部服务，执行前阅读文件说明。send-*.mjs 会实际发送 QQ 消息。patch-*.mjs 修改指定依赖，setup-*.mjs 配置 DSH，不能盲目对生产运行。

统一离线回归入口为 npm run test:audit。预算、诊断与识图还可按对应指南单独运行回归；缺少外部文档或 DSH 安装时，必须明确说明失败或跳过。

前后端与消息链路见 [项目结构与消息链路](guides/项目结构与消息链路.md)，使用文档见 [文档索引](README.md)。
