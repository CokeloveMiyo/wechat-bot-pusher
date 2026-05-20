# 企业微信机器人消息推送工具

通过企业微信 Webhook 机器人发送文本、Markdown 和图片+文字消息，支持定时推送。

## 功能

- **文本消息** — 发送纯文本消息到企业微信群
- **Markdown 消息** — 支持企业微信 Markdown 语法的富文本消息
- **图片+文字** — 先发图片再发文字说明，支持本地上传（自动转 Base64）和图床 URL
- **定时推送** — 设置指定日期时间自动发送消息
- **实时预览** — 编辑消息时右侧实时预览效果
- **发送日志** — 查看历史发送记录和 API 返回状态

## 部署到 Render

### 1. 创建 Render Web Service

在 [Render](https://render.com) 中点击 **New + → Web Service**，连接此 GitHub 仓库。

### 2. 配置

| 配置项 | 值 |
|--------|-----|
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | Free（免费额度足够日常使用） |

### 3. 设置环境变量

在 Render 的 **Environment** 标签中添加：

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `WEBHOOK_KEY` | 企业微信机器人 Webhook Key（从 URL 中提取 `?key=` 后面的部分） | 是 |
| `API_TOKEN` | 访问网站的鉴权令牌，设置后需要此令牌才能使用管理界面 | 推荐 |
| `IMAGE_HOST_TOKEN` | 图床 Token，用于上传本地图片到 [7bu.top](https://7bu.top) | 否 |
| `PORT` | 服务端口，Render 会自动设置，无需手动配置 | 否 |

### 4. 部署

点击 **Create Web Service**，Render 会自动构建并启动。

### 5. 访问并使用

部署完成后，浏览器打开 Render 分配的 URL（如 `https://xxx.onrender.com`）：

1. 点击「+ 新建消息」，输入名称
2. 选择消息类型，编辑内容
3. 点击「立即发送」测试，或「定时推送」设置定时发送

## 获取企业微信 Webhook Key

1. 打开企业微信，进入目标群聊
2. 点击群设置 → 群机器人 → 添加机器人
3. 复制 Webhook 地址：`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx`
4. `key=` 后面的 `xxxxxxxx` 就是 `WEBHOOK_KEY`

## 本地开发

```bash
# 要求 Node.js 24+
git clone <repo-url>
cd webhook-https-qyapi-weixin-qq-com
npm install

# 创建 .env 文件
cp .env.example .env
# 编辑 .env 填入你的 WEBHOOK_KEY 和 API_TOKEN

npm start
# 访问 http://localhost:3456
```

> `.env` 文件不会被 Git 追踪（已在 `.gitignore` 中配置），请勿将凭据提交到仓库。

## 技术栈

- **后端**: Node.js + Express 5
- **数据库**: SQLite (better-sqlite3)
- **前端**: 原生 HTML/CSS/JS（单页应用）
- **部署**: Render Web Service
