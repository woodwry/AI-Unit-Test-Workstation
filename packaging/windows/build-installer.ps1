[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AgentOnedir,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$JavaAnalyzerJar,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$JavaRuntimeDirectory,

    [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string]$ProductVersion = '0.1.3',

    [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string]$AgentServiceVersion = '0.1.0',

    [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string]$JavaAnalyzerVersion = '0.1.0'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$WorkstationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$StageScript = Join-Path $PSScriptRoot 'stage-runtime.ps1'
$BrandingScript = Join-Path $PSScriptRoot 'generate-branding-assets.ps1'
$PackageJson = Join-Path $WorkstationRoot 'package.json'
$BuilderConfig = Join-Path $WorkstationRoot 'electron-builder.json'
$OutputDirectory = Join-Path $WorkstationRoot 'release'
$LocalBuilder = Join-Path $WorkstationRoot 'node_modules\.bin\electron-builder.cmd'
$LocalElectron = Join-Path $WorkstationRoot 'node_modules\electron\dist\electron.exe'
$LocalAppBuilder = Join-Path $WorkstationRoot 'node_modules\app-builder-bin\win\x64\app-builder.exe'
$LocalSevenZip = Join-Path $WorkstationRoot 'node_modules\7zip-bin\win\x64\7za.exe'
$ForbiddenImplicitUpdateMetadata = @(
    (Join-Path $OutputDirectory 'latest.yml'),
    (Join-Path $OutputDirectory 'win-unpacked\resources\app-update.yml')
)
$CandidateInstallerArtifact = Join-Path $OutputDirectory ("AI-Unit-Test-Workstation-Setup-{0}-x64.exe" -f $ProductVersion)
$CandidateInstallerArtifacts = @(
    $CandidateInstallerArtifact,
    "${CandidateInstallerArtifact}.blockmap"
)

# 尽早移除同版本旧候选产物；即使后续输入或缓存预检失败，也不会误取上一轮安装器。
$preBuildCleanupTargets = @($CandidateInstallerArtifacts) + @($ForbiddenImplicitUpdateMetadata)
foreach ($path in $preBuildCleanupTargets) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    }
}

function Assert-RequiredFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "缺少$Label：$Path"
    }
}

function Assert-RequiredDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "缺少$Label：$Path"
    }
}

function Assert-NonEmptyFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Assert-RequiredFile -Path $Path -Label $Label
    if ((Get-Item -LiteralPath $Path).Length -le 0) {
        throw "$Label为空：$Path"
    }
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage（退出码：$LASTEXITCODE）"
    }
}

Assert-RequiredFile -Path $StageScript -Label '运行时 staging 脚本'
Assert-RequiredFile -Path $BrandingScript -Label '品牌图标生成脚本'
Assert-RequiredFile -Path $PackageJson -Label 'package.json'
Assert-RequiredFile -Path $BuilderConfig -Label 'electron-builder 配置'
Assert-RequiredFile -Path $LocalBuilder -Label '本地 electron-builder'
Assert-RequiredFile -Path $LocalElectron -Label '本地 Electron 运行时'
Assert-RequiredFile -Path $LocalAppBuilder -Label '本地 app-builder'
Assert-RequiredFile -Path $LocalSevenZip -Label '本地 7-Zip'

$npmCommand = @(Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue)[0]
if ($null -eq $npmCommand) {
    throw '找不到 npm.cmd，请安装发布契约锁定的 Node.js/npm 工具链'
}

$package = Get-Content -Raw -LiteralPath $PackageJson | ConvertFrom-Json
if ($package.version -ne $ProductVersion) {
    throw "ProductVersion（$ProductVersion）与 package.json 版本（$($package.version)）不一致"
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw '无法定位 LOCALAPPDATA，不能校验 electron-builder 离线缓存'
}
$builderCache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
$nsisCache = Join-Path $builderCache 'nsis'
$winCodeSignCache = Join-Path $builderCache 'winCodeSign'
$nsisVersion = '3.0.4.1'
$nsisResourcesVersion = '3.4.1'
$winCodeSignVersion = '2.6.0'
$nsisDirectory = Join-Path $nsisCache "nsis-$nsisVersion"
$nsisResourcesDirectory = Join-Path $nsisCache "nsis-resources-$nsisResourcesVersion"
$winCodeSignDirectory = Join-Path $winCodeSignCache "winCodeSign-$winCodeSignVersion"
Assert-RequiredDirectory -Path $nsisDirectory -Label "NSIS $nsisVersion 精确缓存目录"
Assert-RequiredFile -Path (Join-Path $nsisDirectory 'Bin\makensis.exe') -Label "NSIS $nsisVersion makensis"
Assert-RequiredDirectory -Path $nsisResourcesDirectory -Label "nsis-resources $nsisResourcesVersion 精确缓存目录"
Assert-RequiredFile -Path (Join-Path $nsisResourcesDirectory 'plugins\x86-unicode\StdUtils.dll') -Label "nsis-resources $nsisResourcesVersion StdUtils"
Assert-RequiredFile -Path (Join-Path $nsisResourcesDirectory 'plugins\x86-unicode\nsis7z.dll') -Label "nsis-resources $nsisResourcesVersion nsis7z"
Assert-RequiredDirectory -Path $winCodeSignDirectory -Label "winCodeSign $winCodeSignVersion 精确缓存目录"
Assert-RequiredFile -Path (Join-Path $winCodeSignDirectory 'rcedit-x64.exe') -Label "winCodeSign $winCodeSignVersion rcedit"
Assert-RequiredFile -Path (Join-Path $winCodeSignDirectory 'windows-6\signtool.exe') -Label "winCodeSign $winCodeSignVersion signtool"

# 发布构建必须显式屏蔽调用进程中可能存在的证书变量，避免误签名或泄露证书材料。
$signingVariables = @(
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_NAME',
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
    'CSC_IDENTITY_AUTO_DISCOVERY',
    'WIN_CSC_IDENTITY_AUTO_DISCOVERY'
)
$savedSigningEnvironment = @{}
foreach ($name in $signingVariables) {
    $savedSigningEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$savedBuilderCache = [Environment]::GetEnvironmentVariable('ELECTRON_BUILDER_CACHE', 'Process')

$locationPushed = $false
$buildValidated = $false
try {
    foreach ($name in @('CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    [Environment]::SetEnvironmentVariable('CSC_IDENTITY_AUTO_DISCOVERY', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('WIN_CSC_IDENTITY_AUTO_DISCOVERY', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('ELECTRON_BUILDER_CACHE', $builderCache, 'Process')

    & $BrandingScript
    Assert-NonEmptyFile -Path (Join-Path $WorkstationRoot 'assets\branding\ai-unit-test-workstation.svg') -Label '品牌 SVG'
    Assert-NonEmptyFile -Path (Join-Path $WorkstationRoot 'assets\branding\ai-unit-test-workstation.ico') -Label '品牌 ICO'
    Assert-NonEmptyFile -Path (Join-Path $WorkstationRoot 'assets\branding\ai-unit-test-workstation-256.png') -Label '品牌 PNG'

    & $StageScript `
        -AgentOnedir $AgentOnedir `
        -JavaAnalyzerJar $JavaAnalyzerJar `
        -JavaRuntimeDirectory $JavaRuntimeDirectory `
        -ProductVersion $ProductVersion `
        -AgentServiceVersion $AgentServiceVersion `
        -JavaAnalyzerVersion $JavaAnalyzerVersion

    Push-Location -LiteralPath $WorkstationRoot
    $locationPushed = $true
    Invoke-CheckedCommand `
        -FilePath $npmCommand.Source `
        -ArgumentList @('run', 'build') `
        -FailureMessage 'workstation 构建失败'
    Invoke-CheckedCommand `
        -FilePath $LocalBuilder `
        -ArgumentList @('--config', $BuilderConfig, '--win', 'nsis', '--x64', '--publish', 'never') `
        -FailureMessage 'NSIS 安装包构建失败'

    Assert-NonEmptyFile -Path $CandidateInstallerArtifact -Label '候选 NSIS 安装器'
    Assert-NonEmptyFile -Path "${CandidateInstallerArtifact}.blockmap" -Label '候选安装器 blockmap'

    $detectedUpdateMetadata = @(
        foreach ($path in $ForbiddenImplicitUpdateMetadata) {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                $path
            }
        }
    )
    if ($detectedUpdateMetadata.Count -gt 0) {
        # 更新元数据已经可能被压入 NSIS；候选安装器优先清理，且单个文件失败不能短路其他清理项。
        $cleanupFailures = @()
        $cleanupTargets = @($CandidateInstallerArtifacts) + @($detectedUpdateMetadata)
        foreach ($path in $cleanupTargets) {
            try {
                if (Test-Path -LiteralPath $path -PathType Leaf) {
                    Remove-Item -LiteralPath $path -Force -ErrorAction Stop
                }
            }
            catch {
                $cleanupFailures += ("{0}（{1}）" -f $path, $_.Exception.Message)
            }
        }
        $remainingPaths = @(
            foreach ($path in $cleanupTargets) {
                if (Test-Path -LiteralPath $path -PathType Leaf) {
                    $path
                }
            }
        )
        $failureMessage = "检测到未配置渠道的更新元数据，已执行候选产物失败关闭清理：$($detectedUpdateMetadata -join ', ')"
        if ($cleanupFailures.Count -gt 0) {
            $failureMessage += "；清理错误：$($cleanupFailures -join '；')"
        }
        if ($remainingPaths.Count -gt 0) {
            $failureMessage += "；仍有残留：$($remainingPaths -join ', ')"
        }
        throw $failureMessage
    }
    $buildValidated = $true
}
finally {
    if (-not $buildValidated) {
        # electron-builder 可能在写出 EXE 后才失败；逐项尽力清理，单个锁定文件不能短路其他目标。
        $failedBuildCleanupErrors = @()
        $failedBuildCleanupTargets = @($CandidateInstallerArtifacts) + @($ForbiddenImplicitUpdateMetadata)
        foreach ($path in $failedBuildCleanupTargets) {
            try {
                if (Test-Path -LiteralPath $path -PathType Leaf) {
                    Remove-Item -LiteralPath $path -Force -ErrorAction Stop
                }
            }
            catch {
                $failedBuildCleanupErrors += ("{0}（{1}）" -f $path, $_.Exception.Message)
            }
        }
        $failedBuildCleanupRemaining = @(
            foreach ($path in $failedBuildCleanupTargets) {
                if (Test-Path -LiteralPath $path -PathType Leaf) {
                    $path
                }
            }
        )
        if ($failedBuildCleanupErrors.Count -gt 0 -or $failedBuildCleanupRemaining.Count -gt 0) {
            Write-Warning ("安装包构建失败后的候选产物清理不完整。错误：{0}；残留：{1}" -f ($failedBuildCleanupErrors -join '；'), ($failedBuildCleanupRemaining -join ', '))
        }
    }
    if ($locationPushed) {
        Pop-Location
    }
    foreach ($name in $signingVariables) {
        [Environment]::SetEnvironmentVariable($name, $savedSigningEnvironment[$name], 'Process')
    }
    [Environment]::SetEnvironmentVariable('ELECTRON_BUILDER_CACHE', $savedBuilderCache, 'Process')
}

Write-Output ("安装包构建完成，输出目录：{0}" -f $OutputDirectory)
