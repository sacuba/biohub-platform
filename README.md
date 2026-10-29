# BioHub · 生信工具平台（开发版）

统一工具入口、OIDC 账号和积分钱包。Node.js 22+，Next.js / TypeScript、Express、oidc-provider、SQLite；不依赖 PostgreSQL 或 Redis。本轮不提供生产部署，未迁移现有 Yinglan 用户。

## 启动与停止

首次在 `platform`、`contracts`、`yinglan` 各执行 `npm ci`。从工作区根目录执行：

```bash
node scripts/dev-stack.mjs start
node scripts/dev-stack.mjs status
node scripts/dev-stack.mjs stop
```

- 平台：<http://192.168.6.111:3200>
- Yinglan 平台联调版：<http://192.168.6.111:3201>
- 单独启动：对应仓库执行 `npm run dev:integration`，前台 Ctrl+C 停止。
- 请统一使用上述 IP，不能混用 localhost，OIDC 回调和 Cookie 有固定来源要求。

启动器显式设置端口、独立 SQLite / 数据路径、`.next-integration` 构建目录、身份模式和模拟接口，不读取生产配置。数据路径解析符号链接后如进入 `*-prod` 将拒绝启动。服务仅监听 `192.168.6.111`；HTTP 仅用于本轮开发联调。

## 数据与账号

`../dev-runtime/platform/` 保存平台 SQLite、身份签名及加密密钥、开发邮件捕获和测试账号；`../dev-runtime/yinglan/` 保存工具 SQLite、私有图片及工具密钥。两个服务独占自己的数据，通过 HTTP 接口协作。原有 Yinglan 开发数据保持独立。

首次启动生成 `admin@biohub.test` 和 `researcher@biohub.test`。随机密码保存在 `../dev-runtime/platform/test-accounts.json`，目录权限 0700，文件权限 0600。仅在服务器上读取，不放入聊天、截图、Git 或网页。管理员的 Yinglan 管理权限是显式配置，平台角色不会自动继承为工具角色。

开发邮件写入 `mail-capture.jsonl`，仅供服务器测试读取，无公开预览路由。后台可保存 SMTP 配置，但联调固定使用邮件捕获，不会发送真实邮件。不导入生产邮件凭据。

启动器状态及日志位于 `../dev-runtime/stack.json`、`platform.log`、`yinglan.log`。`stop` 校验进程工作目录和脚本后仅结束本启动器管理的开发进程；不操作 Docker 或生产任务。不要手工复用这里的 PID。可追加 `platform` 或 `yinglan` 参数，仅操作指定开发服务，例如 `node scripts/dev-stack.mjs stop yinglan`。

## 功能与边界

游客浏览工具大厅；登录后使用任务中心、积分中心、账户及管理员后台。五个未开发工具只有占位，无可执行入口。店铺链接和二维码引导外部购买，兑换码到账，无订阅或在线支付入口。

活动积分包：30 / 100 / 500 / 1000 积分，对应 390 / 990 / 3990 / 6990 分人民币；后台可调整。注册赠送 10、每日赠送 5、赠送 30 天有效，按北京时间日期去重。购买积分永久有效，优先用快到期赠送。所有图像能力当前 5 积分一张；报价在冻结后固定，成功结算，失败及确认取消释放，恢复原桶及有效期。

OIDC 授权码 + PKCE，工具用户按 issuer + subject 映射。全平台退出、停用和改密撤销令牌；Yinglan 每次受保护请求向平台确认授权，平台不可用时不能继续创建付费任务。worker 仅能结束所属工具冻结，不能凭服务身份扣任意用户积分。

生图使用本地带水印的开发模拟；提示词包含 `FAIL` 可模拟失败，`SLOW` 可模拟较慢响应。没有导入供应商真实密钥，不能用本轮结果评价真实模型质量。

## 验证

```bash
# contracts 仓库
npm test
npm run check
# platform 仓库
npm run lint
npm run typecheck
npm test
npm run build
# 启动联调栈后，在 platform 仓库执行（需要本机 Microsoft Edge）
npx tsx scripts/integration.ts
# 真实开发进程停止/重启检查（会短暂中断 3200/3201）
npx tsx scripts/restart-smoke.ts
# yinglan 仓库：独立模式及钱包恢复回归
npm test
npm run lint
npm run typecheck
npm run build
```

构建输出 `.next` 与联调 `.next-integration` 分开。浏览器验收会创建一次性开发用户、任务和兑换码，消耗开发管理员积分；余额不足时可在平台后台调整，不要清除原有开发库。截图位于忽略提交的 `test-results/`。

## 协议与后续工作

公共接口位于相邻 `contracts/openapi/platform-v1.json`（0.1.0），应用保存生成客户端和 SHA-256 锁文件。`npm run contracts:check` 检查漂移；禁止手改 `src/generated`。

后续工具接入见 [接入下一个工具](docs/接入下一个工具.md)。当前 OIDC 客户端、服务作用域及任务聚合仍明确注册 Yinglan，新增工具时必须在平台代码中同步注册并补权限测试；工具清单不会自动注册任意远程服务地址。

工作区启动脚本位于仓库外，平台仓库内的 `scripts/dev.mjs` 是等价单项目入口。若换服务器，请同时搬迁工作区 `AGENTS.md`、`scripts` 和 `docs`，不要复制任何 `dev-runtime` 密钥到代码仓库。本轮未创建平台生产环境，生产域名、HTTPS、真实 SMTP、真实供应商、现有用户迁移与正式发布需独立实施和验收。
