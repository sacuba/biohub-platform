# Platform 开发规则

- 先读工作区 AGENTS.md、README、contracts/README。此仓库负责统一身份、钱包、工具目录和管理后台。
- Node 22+，TypeScript、Next.js、Express、oidc-provider、SQLite。开发入口 `npm run dev:integration`，端口 3200。
- 数据必须在独立开发目录；运行脚本拒绝生产路径及指向生产的符号链接。不使用生产 .env。
- 钱包写入需 SQLite 事务、幂等键和唯一约束；网络调用不得放在数据库事务中。金额为整数分，积分为整数，业务日期使用 Asia/Shanghai。
- 服务身份只允许指定工具的既有冻结结算/释放；新冻结必须有用户授权。密码、SMTP 凭据和令牌不返回浏览器。
- 协议变更先修改 contracts；运行契约生成和校验。生成客户端不得手改。
- 验证：npm run lint、npm run typecheck、npm test、npm run build；联调另按 README 执行。
- 此仓库本轮只做开发环境；禁止部署、读取生产数据或调用真实付费模型。
- 前端入口：`/` 为公开产品介绍页，`/workspace` 为需要登录的工作台；首页不能默认挂载工作台侧栏。登录须保留工具选择、OIDC interaction 和工作台页面去向；更改导航运行 `npx tsx scripts/navigation-smoke.ts`。

- 当前任务已获用户明确授权进行生产上线及旧 Yinglan 用户整体迁移；以根规则“当前生产迁移授权”为准，保留真实账户、密码、积分来源有效期、兑换记录及作品归属。反代/证书由用户配置，未就绪不正式切换。

## 当前 Sanger 发布

用户已授权以 Docker 发布 Sanger，并允许为接入更新平台生产镜像、独立客户端与普通工具权限。保留现有账号/钱包数据，不重启 Yinglan；先冷备份、排空冻结、验证正式 HTTPS/OIDC，再开放。旧 sanger adminuser 数据按用户确认的受限迁移计划显式绑定平台 subject，平台本身不打开工具数据库。首发 0 积分。当前授权优先于原开发限制。
