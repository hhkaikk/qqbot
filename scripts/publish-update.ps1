# 在已验证的公开工作树中运行。改动路径由调用者逐项指定。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string[]]$Files,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Message
)

$ErrorActionPreference = 'Stop'
$publicRepo = 'https://github.com/hhkaikk/qqbot.git'
$publicBranch = 'refs/heads/main'

function Run-Git {
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "Git 操作失败：$($args[0])" }
}

Push-Location (Split-Path -Parent $PSScriptRoot)
$stagedByScript = $false
$committed = $false
try {
    $paths = @($Files | ForEach-Object { $_.Replace('\', '/') } | Sort-Object -Unique)
    if (!$paths.Count) { throw '需要逐项指定本次发布的文件。' }
    foreach ($path in $paths) {
        $publicPath = $path -in @('AGENTS.md', 'README.md', 'README.en.md', 'config.example.json', 'package.json', 'package-lock.json', '.gitignore') -or
            $path -match '^(src|scripts|public|deploy|docs|dsh|plugins|roles|assets|\.github)/[^:\x00-\x1f]+\.(m?js|cjs|json|ya?ml|md|py|ps1|sh|service|timer|conf|html|css|png|jpe?g|svg|webp)$'
        if (!$publicPath -or $path -match '(^|/)(\.{1,2}|\.env[^/]*|state|node_modules|backups?|credentials?|secrets?)(/|$)') {
            throw "路径不在公开文件范围：$path"
        }
        if (Test-Path -LiteralPath $path -PathType Container) { throw "请指定文件：$path" }
    }

    $null = Get-Command gitleaks
    if (Run-Git diff --cached --name-only) { throw '暂存区已有改动，请用干净的公开工作树。' }
    $local = Run-Git rev-parse HEAD
    $remote = Run-Git ls-remote --exit-code $publicRepo $publicBranch
    if (($remote -split '\s+')[0] -ne $local) { throw '公开工作树基线与 GitHub main 不一致。' }

    $stagedByScript = $true
    Run-Git -c core.safecrlf=false --literal-pathspecs add -A -- @paths
    $staged = @(Run-Git -c core.quotepath=false diff --cached --name-only --no-renames)
    if (!$staged.Count) {
        Write-Output "GitHub 已同步：https://github.com/hhkaikk/qqbot/commit/$local"
        return
    }
    if (@($staged | Where-Object { $_ -cnotin $paths }).Count) { throw '暂存区包含本次未选择的路径。' }
    Run-Git diff --cached --check
    & gitleaks git --staged --redact --no-banner
    if ($LASTEXITCODE -ne 0) { throw '密钥扫描未通过或扫描工具异常。' }
    Run-Git -c user.name=hhkaikk -c 'user.email=133870711+hhkaikk@users.noreply.github.com' commit -m $Message
    $committed = $true
    $commit = Run-Git rev-parse HEAD
    Run-Git push $publicRepo "HEAD:$publicBranch"
    $remote = Run-Git ls-remote --exit-code $publicRepo $publicBranch
    if (($remote -split '\s+')[0] -ne $commit) { throw '推送后远端提交与本地不一致。' }
    Write-Output "GitHub 已同步：https://github.com/hhkaikk/qqbot/commit/$commit"
} catch {
    if ($stagedByScript -and !$committed) {
        & git --literal-pathspecs restore --staged -- @paths
        if ($LASTEXITCODE -ne 0) { Write-Warning '无法撤回本次暂存，请检查 Git 索引。' }
    }
    throw
} finally {
    Pop-Location
}
