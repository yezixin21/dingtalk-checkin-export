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
    ├── export_node.js    # 主脚本：拉取 + 导出 CSV
    ├── load_env.js       # .env 加载模块
    ├── config.json       # 非敏感配置（输出路径、部门 ID）
    └── daily_checkin.bat # 双击运行
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

```bash
# 方式一：命令行
node 核心文件/export_node.js

# 方式二：双击 daily_checkin.bat
```

## 配置说明

| 文件 | 说明 |
|------|------|
| `.env` | 钉钉应用 AppKey / AppSecret（敏感，已 Git 忽略） |
| `config.json` | `outputPath`：CSV 输出目录；`department_id`：部门 ID |

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
