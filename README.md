# 交易单生成器 v4

## 使用
- 直接双击 `index.html` 就能用（行情走币安公开接口，不需要密钥）。
- 想装成手机/电脑 App（PWA）：把整个文件夹放到 HTTPS 站点或本机 `python3 -m http.server`，用浏览器“添加到主屏幕/安装”。

## 后端（可选：持仓、成交、AI 起草、存证、云同步）
```
APP_TOKEN=<至少16位随机串> ALLOW_ORIGIN=https://你的页面域名 \
BINANCE_API_KEY=... BINANCE_API_SECRET=... ANTHROPIC_API_KEY=... node server.js
```
- 页面里“你的后端地址”填 `http://localhost:8787`（本机）或你的 HTTPS 地址，“后端访问令牌”填 APP_TOKEN。
- 本地 file:// 页面使用后端时：`ALLOW_ORIGIN=null`。
- 币安 Key 只给**只读**权限并绑定 IP；Secret 永远不要放进网页。
- 接口：`GET /positions`、`GET /fills?symbol=&since=`、`POST /stamp`、`GET /verify/:id?hash=`、`POST /ai/draft`、`GET|PUT /sync`。

## 注意
- 规则草稿 / AI 草稿只是起点，卡片上会标注“草稿”，必须你自己核对后再发；不会自动发单。
- 价格提醒靠每秒采样，可能漏掉瞬间插针；需页面保持打开。
- 复盘按 K 线高低点推算，不含滑点；同一根 K 线内同时触及止盈止损时无法判断先后。
- 强平价是逐仓近似值，以交易所为准。
- 存证只有经你的后端盖章才有时间证明力，否则只是本地编号。
- 对外发布交易信号可能涉及所在地的监管要求，请自行确认。本工具不构成投资建议。
