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

$MarkerName = '.ai-unit-test-managed-stage'
$MarkerContent = 'AI_UNIT_TEST_WORKSTATION_MANAGED_STAGE_V1'
$JavaDistribution = 'Eclipse Temurin'
$JavaVendor = 'Eclipse Adoptium'
$JavaRuntimeVersion = '21.0.11+10'
$JavaArchitecture = 'x86_64'
$WorkstationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$OutputDirectory = [System.IO.Path]::GetFullPath((Join-Path $WorkstationRoot 'build-resources'))

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-RequiredAbsolutePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][ValidateSet('File', 'Directory')][string]$Kind
    )
    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        throw "$Label 必须使用显式绝对路径"
    }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $fullPath)) {
        throw "$Label 不存在"
    }
    $item = Get-Item -Force -LiteralPath $fullPath
    if ($Kind -eq 'File' -and $item.PSIsContainer) {
        throw "$Label 必须是文件"
    }
    if ($Kind -eq 'Directory' -and -not $item.PSIsContainer) {
        throw "$Label 必须是目录"
    }
    return $item.FullName
}

function Test-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate
    )
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    return $candidateFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-PathInside -Root $Root -Candidate $Candidate)) {
        throw "$Label 超出允许目录"
    }
}

function Resolve-SafeDestination {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $normalized = $RelativePath.Replace('\', '/')
    if (
        [string]::IsNullOrWhiteSpace($normalized) -or
        $normalized.StartsWith('/') -or
        $normalized -match '^[A-Za-z]:' -or
        $normalized.Split('/') -contains '..'
    ) {
        throw "$Label 相对路径无效"
    }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $normalized.Replace('/', '\')))
    Assert-PathInside -Root $Root -Candidate $candidate -Label $Label
    return $candidate
}

function Assert-NoReparsePoints {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $reparsePoint = Get-ChildItem -Force -Recurse -LiteralPath $Directory | Where-Object {
        ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    } | Select-Object -First 1
    if ($null -ne $reparsePoint) {
        throw "$Label 包含不允许的重解析点"
    }
}

function Assert-NoSensitiveFiles {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $forbiddenFile = Get-ChildItem -Force -Recurse -File -LiteralPath $Directory | Where-Object {
        $_.Name -eq '.env' -or
        $_.Name -like '.env.*' -or
        $_.Name -match '^(?i:secrets|credentials)\.json$' -or
        $_.Name -match '^(?i:id_rsa|id_ed25519)$' -or
        $_.Extension -match '^(?i:\.p12|\.pfx|\.jks)$'
    } | Select-Object -First 1
    if ($null -ne $forbiddenFile) {
        throw 'agent-service onedir 包含 .env 或疑似密钥文件'
    }

    $textExtensions = @('.py', '.json', '.toml', '.yaml', '.yml', '.txt', '.ini', '.cfg', '.xml', '.properties', '.ps1', '.cmd', '.bat', '.md')
    $assignmentPattern = '(?im)\b(?:DASHSCOPE_API_KEY|OPENAI_API_KEY|AZURE_OPENAI_API_KEY|AI_UNIT_TEST_ACCESS_TOKEN|AGENT_JAVA_ANALYZER_ACCESS_TOKEN)\b\s*[:=]\s*(["''])([A-Za-z0-9._~+/\-]{12,})\1'
    # PyInstaller 会携带第三方库源码及其文档示例；只放行已确认的固定占位符，其他字面量仍阻断 staging。
    $allowedDocumentationPlaceholders = @(
        'api_key_here',
        'your-api-key',
        'random-string',
        'your-dashscope-api-key'
    )
    $secretPatterns = @(
        '(?i)\bsk-[A-Za-z0-9_-]{16,}\b',
        '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
    )
    foreach ($file in Get-ChildItem -Force -Recurse -File -LiteralPath $Directory) {
        if ($textExtensions -notcontains $file.Extension.ToLowerInvariant() -or $file.Length -gt 2MB) {
            continue
        }
        try {
            $content = [System.IO.File]::ReadAllText($file.FullName)
        }
        catch {
            throw '无法完成 agent-service 文本资源的敏感信息检查'
        }
        foreach ($match in [regex]::Matches($content, $assignmentPattern)) {
            if ($allowedDocumentationPlaceholders -notcontains $match.Groups[2].Value) {
                throw 'agent-service onedir 包含疑似明文密钥'
            }
        }
        foreach ($pattern in $secretPatterns) {
            if ($content -match $pattern) {
                throw 'agent-service onedir 包含疑似明文密钥'
            }
        }
    }
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($item in Get-ChildItem -Force -LiteralPath $Source) {
        Copy-Item -Force -Recurse -LiteralPath $item.FullName -Destination $Destination
    }
}

function Get-RelativeForwardPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )
    Assert-PathInside -Root $Root -Candidate $Path -Label 'manifest 文件'
    return $Path.Substring($Root.TrimEnd('\', '/').Length + 1).Replace('\', '/')
}

function Assert-ManagedDirectory {
    param([Parameter(Mandatory = $true)][string]$Directory)
    Assert-PathInside -Root $WorkstationRoot -Candidate $Directory -Label '受管 staging 目录'
    $marker = Join-Path $Directory $MarkerName
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw '拒绝操作没有受管 marker 的 staging 目录'
    }
    $actual = [System.IO.File]::ReadAllText($marker).Trim()
    if ($actual -ne $MarkerContent) {
        throw '拒绝操作 marker 不匹配的 staging 目录'
    }
}

function Remove-ManagedDirectory {
    param([Parameter(Mandatory = $true)][string]$Directory)
    if (-not (Test-Path -LiteralPath $Directory)) {
        return
    }
    Assert-ManagedDirectory -Directory $Directory
    Remove-Item -Force -Recurse -LiteralPath $Directory
}

function Assert-JavaRuntimeIdentity {
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
    $javaw = Join-Path $RuntimeRoot 'bin\javaw.exe'
    $releaseFile = Join-Path $RuntimeRoot 'release'
    $legalDirectory = Join-Path $RuntimeRoot 'legal'
    if (-not (Test-Path -LiteralPath $javaw -PathType Leaf)) {
        throw 'JRE 缺少 bin/javaw.exe'
    }
    if (-not (Test-Path -LiteralPath $releaseFile -PathType Leaf)) {
        throw 'JRE 缺少 release 身份文件'
    }
    if (-not (Test-Path -LiteralPath $legalDirectory -PathType Container)) {
        throw 'JRE 缺少 legal 许可证目录'
    }
    if ((Get-ChildItem -Force -Recurse -File -LiteralPath $legalDirectory | Measure-Object).Count -eq 0) {
        throw 'JRE legal 许可证目录为空'
    }
    $release = [System.IO.File]::ReadAllText($releaseFile)
    if ($release -notmatch '(?m)^IMPLEMENTOR="Eclipse Adoptium"\r?$') {
        throw 'JRE 供应商不是 Eclipse Adoptium'
    }
    if ($release -notmatch '(?m)^JAVA_VERSION="21\.0\.11"\r?$') {
        throw 'JRE Java 版本不是 21.0.11'
    }
    if ($release -notmatch '(?m)^JAVA_RUNTIME_VERSION="21\.0\.11\+10(?:-LTS)?"\r?$') {
        throw 'JRE runtime build 不是 21.0.11+10'
    }
    if ($release -notmatch '(?m)^OS_ARCH="(?:amd64|x86_64)"\r?$') {
        throw 'JRE 架构不是 x86_64'
    }
}

function Assert-LegalTreeCopied {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRuntime,
        [Parameter(Mandatory = $true)][string]$StagedRuntime
    )
    $sourceLegal = Join-Path $SourceRuntime 'legal'
    $stagedLegal = Join-Path $StagedRuntime 'legal'
    $sourceFiles = @(Get-ChildItem -Force -Recurse -File -LiteralPath $sourceLegal | Sort-Object FullName)
    $stagedFiles = @(Get-ChildItem -Force -Recurse -File -LiteralPath $stagedLegal | Sort-Object FullName)
    if ($sourceFiles.Count -ne $stagedFiles.Count) {
        throw 'JRE legal 目录没有完整复制'
    }
    foreach ($sourceFile in $sourceFiles) {
        $relativePath = Get-RelativeForwardPath -Root $sourceLegal -Path $sourceFile.FullName
        $stagedFile = Resolve-SafeDestination -Root $stagedLegal -RelativePath $relativePath -Label 'JRE legal 文件'
        if (-not (Test-Path -LiteralPath $stagedFile -PathType Leaf)) {
            throw 'JRE legal 目录没有完整复制'
        }
        $targetItem = Get-Item -LiteralPath $stagedFile
        if ($targetItem.Length -ne $sourceFile.Length) {
            throw 'JRE legal 文件大小不一致'
        }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $sourceFile.FullName).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedFile).Hash) {
            throw 'JRE legal 文件哈希不一致'
        }
    }
}

function New-ManifestFileRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][System.IO.FileInfo]$File
    )
    return [ordered]@{
        path = Get-RelativeForwardPath -Root $Root -Path $File.FullName
        size = [int64]$File.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName).Hash.ToLowerInvariant()
    }
}

function Sort-ManifestFileRecordsOrdinal {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Records
    )

    # manifest 的读取端使用 JavaScript 序数比较；这里必须显式采用同一规则，
    # 不能依赖 Sort-Object 的当前区域性，否则不同机器可能生成不可启动的安装包。
    $sorted = [System.Collections.Generic.List[object]]::new()
    foreach ($record in $Records) {
        $sorted.Add($record)
    }
    $sorted.Sort([System.Comparison[object]]{
        param($left, $right)
        return [System.StringComparer]::Ordinal.Compare([string]$left.path, [string]$right.path)
    })
    return @($sorted)
}

$agentRoot = Get-RequiredAbsolutePath -Path $AgentOnedir -Label 'agent-service onedir' -Kind Directory
$analyzerJar = Get-RequiredAbsolutePath -Path $JavaAnalyzerJar -Label 'java-analyzer fat Jar' -Kind File
$javaRuntimeRoot = Get-RequiredAbsolutePath -Path $JavaRuntimeDirectory -Label 'Temurin JRE' -Kind Directory

if ([System.IO.Path]::GetExtension($analyzerJar) -ne '.jar') {
    throw 'java-analyzer 输入必须是 fat Jar 文件'
}
if (-not (Test-Path -LiteralPath (Join-Path $agentRoot 'agent-service.exe') -PathType Leaf)) {
    throw 'agent-service onedir 缺少 agent-service.exe'
}
if (-not (Test-Path -LiteralPath (Join-Path $agentRoot '_internal') -PathType Container)) {
    throw 'agent-service onedir 缺少 _internal 目录'
}
foreach ($source in @($agentRoot, $analyzerJar, $javaRuntimeRoot)) {
    if ((Test-PathInside -Root $OutputDirectory -Candidate $source) -or (Test-PathInside -Root $source -Candidate $OutputDirectory)) {
        throw 'staging 输入不得与 build-resources 重叠'
    }
}

Assert-NoReparsePoints -Directory $agentRoot -Label 'agent-service onedir'
Assert-NoReparsePoints -Directory $javaRuntimeRoot -Label 'Temurin JRE'
Assert-NoSensitiveFiles -Directory $agentRoot
Assert-JavaRuntimeIdentity -RuntimeRoot $javaRuntimeRoot

$noticesSource = Join-Path $PSScriptRoot 'licenses\THIRD_PARTY_NOTICES_ZH.txt'
if (-not (Test-Path -LiteralPath $noticesSource -PathType Leaf)) {
    throw '缺少第三方 notices 文件'
}
$releaseContractSource = Join-Path $PSScriptRoot 'release-contract.json'
if (-not (Test-Path -LiteralPath $releaseContractSource -PathType Leaf)) {
    throw '缺少 canonical Windows 发布契约'
}

$stageId = [Guid]::NewGuid().ToString('N')
$temporaryDirectory = [System.IO.Path]::GetFullPath((Join-Path $WorkstationRoot ('.build-resources.stage-' + $stageId)))
$backupDirectory = [System.IO.Path]::GetFullPath((Join-Path $WorkstationRoot ('.build-resources.backup-' + $stageId)))
Assert-PathInside -Root $WorkstationRoot -Candidate $temporaryDirectory -Label '临时 staging 目录'
Assert-PathInside -Root $WorkstationRoot -Candidate $backupDirectory -Label '备份 staging 目录'

try {
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    Write-Utf8NoBom -Path (Join-Path $temporaryDirectory $MarkerName) -Content ($MarkerContent + [Environment]::NewLine)

    $agentDestination = Resolve-SafeDestination -Root $temporaryDirectory -RelativePath 'backend/agent-service' -Label 'agent-service 目标'
    $analyzerDestination = Resolve-SafeDestination -Root $temporaryDirectory -RelativePath 'backend/java-analyzer/java-analyzer.jar' -Label 'java-analyzer 目标'
    $jreDestination = Resolve-SafeDestination -Root $temporaryDirectory -RelativePath 'runtimes/java-21' -Label 'JRE 目标'
    $noticesDestination = Resolve-SafeDestination -Root $temporaryDirectory -RelativePath 'licenses/THIRD_PARTY_NOTICES_ZH.txt' -Label 'notices 目标'
    $releaseContractDestination = Resolve-SafeDestination -Root $temporaryDirectory -RelativePath 'release-contract.json' -Label '发布契约目标'

    Copy-DirectoryContents -Source $agentRoot -Destination $agentDestination
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($analyzerDestination)) | Out-Null
    Copy-Item -Force -LiteralPath $analyzerJar -Destination $analyzerDestination
    Copy-DirectoryContents -Source $javaRuntimeRoot -Destination $jreDestination
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($noticesDestination)) | Out-Null
    Copy-Item -Force -LiteralPath $noticesSource -Destination $noticesDestination
    Copy-Item -Force -LiteralPath $releaseContractSource -Destination $releaseContractDestination

    Assert-LegalTreeCopied -SourceRuntime $javaRuntimeRoot -StagedRuntime $jreDestination
    Assert-NoSensitiveFiles -Directory $agentDestination

    $manifestFiles = @(Sort-ManifestFileRecordsOrdinal -Records @(
        Get-ChildItem -Force -Recurse -File -LiteralPath $temporaryDirectory |
            ForEach-Object { New-ManifestFileRecord -Root $temporaryDirectory -File $_ }
    ))
    for ($index = 1; $index -lt $manifestFiles.Count; $index += 1) {
        $previousPath = [string]$manifestFiles[$index - 1].path
        $currentPath = [string]$manifestFiles[$index].path
        if ([System.StringComparer]::Ordinal.Compare($previousPath, $currentPath) -ge 0) {
            throw 'staging 资源清单未按序数规则严格排序'
        }
    }
    $fileByPath = @{}
    foreach ($file in $manifestFiles) {
        if ($fileByPath.ContainsKey($file.path.ToLowerInvariant())) {
            throw 'staging 产物包含 Windows 大小写冲突路径'
        }
        $fileByPath[$file.path.ToLowerInvariant()] = $file
    }

    $agentEntryPath = 'backend/agent-service/agent-service.exe'
    $analyzerEntryPath = 'backend/java-analyzer/java-analyzer.jar'
    $javaEntryPath = 'runtimes/java-21/bin/javaw.exe'
    $releaseContractPath = 'release-contract.json'
    if (-not $fileByPath.ContainsKey($releaseContractPath)) {
        throw 'staging 产物缺少 canonical Windows 发布契约'
    }
    if ([int64]$fileByPath[$releaseContractPath].size -le 0) {
        throw 'staging 中的 canonical Windows 发布契约为空'
    }
    foreach ($entryPath in @($agentEntryPath, $analyzerEntryPath, $javaEntryPath)) {
        if (-not $fileByPath.ContainsKey($entryPath)) {
            throw 'staging 产物缺少受管服务入口文件'
        }
        if ([int64]$fileByPath[$entryPath].size -le 0) {
            throw 'staging 服务入口文件为空'
        }
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        product = [ordered]@{
            version = $ProductVersion
            platform = 'win32'
            arch = 'x64'
        }
        javaRuntime = [ordered]@{
            distribution = $JavaDistribution
            vendor = $JavaVendor
            version = $JavaRuntimeVersion
            architecture = $JavaArchitecture
        }
        components = [ordered]@{
            agentService = [ordered]@{ version = $AgentServiceVersion }
            javaAnalyzer = [ordered]@{ version = $JavaAnalyzerVersion }
        }
        entrypoints = [ordered]@{
            agentService = $fileByPath[$agentEntryPath]
            javaAnalyzer = $fileByPath[$analyzerEntryPath]
            javaRuntime = $fileByPath[$javaEntryPath]
        }
        files = $manifestFiles
    }
    $manifestPath = Join-Path $temporaryDirectory 'backend-manifest.json'
    Write-Utf8NoBom -Path $manifestPath -Content (($manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine)

    if (Test-Path -LiteralPath $OutputDirectory) {
        Assert-ManagedDirectory -Directory $OutputDirectory
        Move-Item -LiteralPath $OutputDirectory -Destination $backupDirectory
    }
    try {
        Move-Item -LiteralPath $temporaryDirectory -Destination $OutputDirectory
    }
    catch {
        if (Test-Path -LiteralPath $OutputDirectory) {
            Remove-ManagedDirectory -Directory $OutputDirectory
        }
        if (Test-Path -LiteralPath $backupDirectory) {
            Move-Item -LiteralPath $backupDirectory -Destination $OutputDirectory
        }
        throw
    }
    if (Test-Path -LiteralPath $backupDirectory) {
        Remove-ManagedDirectory -Directory $backupDirectory
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-ManagedDirectory -Directory $temporaryDirectory
    }
}

Write-Output "已生成受管运行时 staging：$OutputDirectory"
