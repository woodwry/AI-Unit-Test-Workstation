[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workstationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$brandingDirectory = Join-Path $workstationRoot 'assets\branding'
$svgPath = Join-Path $brandingDirectory 'ai-unit-test-workstation.svg'
$pngPath = Join-Path $brandingDirectory 'ai-unit-test-workstation-256.png'
$png1024Path = Join-Path $brandingDirectory 'ai-unit-test-workstation-1024.png'
$icoPath = Join-Path $brandingDirectory 'ai-unit-test-workstation.ico'

function Assert-BrandingFile {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "缺少$Label：$Path" }
    if ((Get-Item -LiteralPath $Path).Length -le 0) { throw "$Label为空：$Path" }
}

Add-Type -AssemblyName System.Drawing
# Windows PowerShell 5.1 may decode UTF-8 scripts without a BOM using the
# active code page. Keep command arguments ASCII so labels cannot be split
# during parameter binding; user-facing errors remain localized below.
Assert-BrandingFile -Path $svgPath -Label 'branding SVG source'

$icoSizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$renderSizes = $icoSizes + @(512, 1024)
$bitmaps = @{}
try {
    foreach ($size in $renderSizes) {
        $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $bitmap.SetResolution(96, 96)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $graphics.Clear([System.Drawing.Color]::FromArgb(255, 17, 24, 39))
            $scale = $size / 64.0
            $background = [System.Drawing.Drawing2D.GraphicsPath]::new()
            $background.AddArc(1 * $scale, 1 * $scale, 30 * $scale, 30 * $scale, 180, 90)
            $background.AddArc(33 * $scale, 1 * $scale, 30 * $scale, 30 * $scale, 270, 90)
            $background.AddArc(33 * $scale, 33 * $scale, 30 * $scale, 30 * $scale, 0, 90)
            $background.AddArc(1 * $scale, 33 * $scale, 30 * $scale, 30 * $scale, 90, 90)
            $background.CloseFigure()
            $graphics.FillPath(
                [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 17, 24, 39)),
                $background
            )

            $penLeft = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 34, 211, 238), [Math]::Max(1.5, 5 * $scale))
            $penRight = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 167, 139, 250), [Math]::Max(1.5, 5 * $scale))
            $penCheck = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 74, 222, 128), [Math]::Max(1.5, 5 * $scale))
            foreach ($pen in @($penLeft, $penRight, $penCheck)) {
                $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
                $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
                $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            }
            $graphics.DrawLines($penLeft, @(
                [System.Drawing.PointF]::new(21.5 * $scale, 19.5 * $scale),
                [System.Drawing.PointF]::new(12 * $scale, 31.5 * $scale),
                [System.Drawing.PointF]::new(21.5 * $scale, 43.5 * $scale)
            ))
            $graphics.DrawLines($penRight, @(
                [System.Drawing.PointF]::new(42.5 * $scale, 19.5 * $scale),
                [System.Drawing.PointF]::new(52 * $scale, 31.5 * $scale),
                [System.Drawing.PointF]::new(42.5 * $scale, 43.5 * $scale)
            ))
            $graphics.DrawLines($penCheck, @(
                [System.Drawing.PointF]::new(26.5 * $scale, 33.5 * $scale),
                [System.Drawing.PointF]::new(31 * $scale, 38 * $scale),
                [System.Drawing.PointF]::new(38 * $scale, 29 * $scale)
            ))
            $bitmaps[$size] = $bitmap
        }
        finally {
            $graphics.Dispose()
        }
    }

    $bitmaps[256].Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmaps[1024].Save($png1024Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $stream = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $writer = New-Object System.IO.BinaryWriter($stream)
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$icoSizes.Count)
        $imageBytes = @{}
        foreach ($size in $icoSizes) {
            $memory = [System.IO.MemoryStream]::new()
            $bitmaps[$size].Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
            $imageBytes[$size] = $memory.ToArray()
            $memory.Dispose()
        }
        $offset = 6 + (16 * $icoSizes.Count)
        foreach ($size in $icoSizes) {
            $byteSize = if ($size -ge 256) { 0 } else { $size }
            $writer.Write([Byte]$byteSize)
            $writer.Write([Byte]$byteSize)
            $writer.Write([Byte]0)
            $writer.Write([Byte]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$imageBytes[$size].Length)
            $writer.Write([UInt32]$offset)
            $offset += $imageBytes[$size].Length
        }
        foreach ($size in $icoSizes) { $writer.Write($imageBytes[$size]) }
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}
finally {
    foreach ($bitmap in $bitmaps.Values) { $bitmap.Dispose() }
}

Assert-BrandingFile -Path $pngPath -Label 'branding PNG'
Assert-BrandingFile -Path $png1024Path -Label '1024px branding PNG'
Assert-BrandingFile -Path $icoPath -Label 'Windows ICO'
Write-Output 'Branding assets generated.'
