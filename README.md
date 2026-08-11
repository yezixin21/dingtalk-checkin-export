# 钉钉签到导出工具

自动从钉钉开放平台拉取部门签到记录，导出为 UTF-8 CSV（兼容 Excel 直接打开）。

## 目录结构

```
钉钉签到/
├── .env                  # 钉钉 API 凭据（不提交 Git）
├── .env.example          # 凭据模板
├── .gitignore            # Git 忽略规则
├── README.md             # 本文件
├── 签到2026_XX.csv       # 导出的签到数据
└── 核心文件/
    ├── load_env.js       # 共用：.env 加载模块
    ├── config.json       # 共用：非敏感配置
    ├── Web端/
    │   ├── server.js     # Web 应用入口
    │   └── server.bat    # 双击启动 Web 服务
    └── CLI端/
        ├── export_node.js    # CLI 脚本入口
        └── daily_checkin.bat # 双击运行 CLI 模式
```

## 快速开始

### 1. 安装 Node.js

需要 Node.js 18+（内置 `fetch` API）。

### 2. 配置凭据

```bash
cp .env.example .env
# 编辑 .env，填入真实 DINGTALK_APPKEY / DINGTALK_APPSECRET
```

### 3. 运行

**Web 应用（推荐）：**

```bash
node 核心文件/Web端/server.js
# 或双击核心文件/Web端/server.bat，浏览器自动打开 http://localhost:3000
```

- 日历点选起止日期，点击切换月份
- 下拉选择部门
- 预览确认后一键导出 CSV

**CLI 模式：**

```bash
node 核心文件/CLI端/export_node.js
# 或双击核心文件/CLI端/daily_checkin.bat
```

## 配置说明

| 文件 | 说明 |
|------|------|
| `.env` | 钉钉应用 AppKey / AppSecret（敏感，已 Git 忽略） |
| `config.json` | `outputPath`：CSV 输出目录 |

## 使用流程

### Web 应用
1. 双击 `核心文件/Web端/server.bat` 或在终端运行 `node 核心文件/Web端/server.js`
2. 浏览器自动打开，页面加载部门列表
3. 点击日历选择起止日期（第一次点击 = 起始，第二次点击 = 结束）
4. 点击「预览数据」确认记录数
5. 点击「导出 CSV」下载文件
6. 关闭浏览器标签页，服务器自动退出

### CLI 模式
1. 运行脚本后，自动拉取钉钉部门列表
2. 输入数字选择要导出的部门
3. 输入导出时间范围（YYYY-MM 格式，直接回车默认本月）
4. 脚本自动分页拉取并导出 CSV

## 导出格式

CSV 表头：序号, 姓名, 签到时间, 签到地点, 详细地址, 纬度, 经度, 备注, 图1...图N

- **备注**：自动提取字母数字 token（产品代码），逗号分隔
- **图1-图N**：签到照片 URL 列，自动适配实际图片数量
- **编码**：UTF-8 with BOM（Excel 直接打开不乱码）

## 技术要点

- 并行分页拉取（并发度 3），比串行快 ~80%
- 凭据通过 `.env` 文件加载，不硬编码
- 零 npm 依赖，仅使用 Node.js 内置模块
- 自动重试机制（网络异常重试 3 次）
