# ================================================
#  钉钉签到 - 创建快捷方式
#  双击「创建快捷方式.bat」运行本脚本。
#  根据脚本所在目录自动生成带图标的快捷方式，可跨电脑使用。
# ================================================
$ErrorActionPreference = 'Stop'

$root  = $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell

# 快捷方式定义：@('快捷方式相对路径', '目标 .bat 相对路径', '图标相对路径')
$shortcuts = @(
    @('一键安装.lnk',                      'setup.bat',                            'icons\setup.ico'),
    @('核心文件\Web端\启动 Web 导出.lnk',  '核心文件\Web端\server.bat',             'icons\web.ico'),
    @('核心文件\CLI端\命令行导出.lnk',     '核心文件\CLI端\daily_checkin.bat',      'icons\checkin.ico')
)

$count = 0
foreach ($s in $shortcuts) {
    $lnk    = Join-Path $root $s[0]
    $target = Join-Path $root $s[1]
    $icon   = Join-Path $root $s[2]

    if (-not (Test-Path -LiteralPath $target)) {
        Write-Host ("[跳过] 找不到目标: " + $s[1]) -ForegroundColor Yellow
        continue
    }

    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath       = $target
    $sc.WorkingDirectory = Split-Path $target -Parent
    $sc.IconLocation     = $icon + ',0'
    $sc.Description      = $s[1]
    $sc.Save()

    Write-Host ("[OK] " + $s[0]) -ForegroundColor Green
    $count++
}

Write-Host ''
Write-Host ("完成：共创建 " + $count + " 个快捷方式。")
Write-Host '提示：若图标未刷新，请在资源管理器窗口按 F5。'
