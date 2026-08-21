# Generates the suite's three icons into Installer\launcher:
#
#   emerald.ico          the control panel, the tray icon and the setup executable
#   emerald-capture.ico  the Emerald Capture desktop application
#   liveedit.ico         the LiveEdit desktop application
#
# The two applications need visibly different icons or they are indistinguishable in the taskbar
# and Alt-Tab, which is the main thing a desktop app buys over a pair of browser tabs. They are
# drawn here rather than committed as binaries so they can be regenerated or restyled without a
# design tool in the loop. Each size is stored as a PNG inside the ICO container, which Windows
# has supported since Vista and which keeps the 256px entry from bloating the file.

param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\launcher")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)

function New-SuiteIcon {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Glyph,
        [Parameter(Mandatory = $true)][System.Drawing.Color]$Start,
        [Parameter(Mandatory = $true)][System.Drawing.Color]$End,
        [System.Drawing.Color]$Foreground = [System.Drawing.Color]::FromArgb(255, 233, 252, 245),
        # Drawn as a small filled circle in the lower right: a record dot for capture, absent
        # elsewhere. Still legible at 32px, which a second glyph would not be.
        [switch]$RecordDot
    )

    $pngs = @()

    foreach ($size in $sizes) {
        $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.Clear([System.Drawing.Color]::Transparent)

        $inset = [Math]::Max(1, [int]($size * 0.06))
        $rect = New-Object System.Drawing.Rectangle($inset, $inset, ($size - 2 * $inset), ($size - 2 * $inset))

        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $Start, $End, 45.0)

        $radius = [int]($size * 0.22)
        $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
        if ($radius -gt 1) {
            $d = $radius * 2
            $shape.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
            $shape.AddArc(($rect.Right - $d), $rect.Y, $d, $d, 270, 90)
            $shape.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d, 0, 90)
            $shape.AddArc($rect.X, ($rect.Bottom - $d), $d, $d, 90, 90)
            $shape.CloseFigure()
        }
        else {
            $shape.AddRectangle($rect)
        }
        $graphics.FillPath($brush, $shape)

        # Below 24px a letterform turns to mush, so those sizes get a simpler bar motif instead.
        if ($size -ge 24) {
            $font = New-Object System.Drawing.Font("Segoe UI", ($size * 0.52), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
            $format = New-Object System.Drawing.StringFormat
            $format.Alignment = [System.Drawing.StringAlignment]::Center
            $format.LineAlignment = [System.Drawing.StringAlignment]::Center
            $textBrush = New-Object System.Drawing.SolidBrush $Foreground
            $graphics.DrawString($Glyph, $font, $textBrush, [System.Drawing.RectangleF]$rect, $format)
            $textBrush.Dispose()
            $font.Dispose()
            $format.Dispose()
        }
        else {
            $barBrush = New-Object System.Drawing.SolidBrush $Foreground
            $barHeight = [Math]::Max(1, [int]($size * 0.12))
            $barWidth = [int]($rect.Width * 0.55)
            $barX = $rect.X + [int](($rect.Width - $barWidth) / 2)
            for ($i = 0; $i -lt 3; $i++) {
                $barY = $rect.Y + [int]($rect.Height * (0.25 + 0.22 * $i))
                $graphics.FillRectangle($barBrush, $barX, $barY, $barWidth, $barHeight)
            }
            $barBrush.Dispose()
        }

        if ($RecordDot -and $size -ge 32) {
            $dotDiameter = [int]($size * 0.26)
            $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 229, 62, 62))
            $ringPen = New-Object System.Drawing.Pen ($Start, [Math]::Max(1.0, $size * 0.05))
            $dotX = $rect.Right - $dotDiameter - [int]($size * 0.06)
            $dotY = $rect.Bottom - $dotDiameter - [int]($size * 0.06)
            $graphics.FillEllipse($dotBrush, $dotX, $dotY, $dotDiameter, $dotDiameter)
            $graphics.DrawEllipse($ringPen, $dotX, $dotY, $dotDiameter, $dotDiameter)
            $dotBrush.Dispose()
            $ringPen.Dispose()
        }

        $graphics.Dispose()
        $brush.Dispose()
        $shape.Dispose()

        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngs += , $stream.ToArray()
        $stream.Dispose()
        $bitmap.Dispose()
    }

    # ICO container: 6-byte header, then a 16-byte directory entry per image, then the PNG payloads.
    $output = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($output)
    $writer.Write([UInt16]0)              # reserved
    $writer.Write([UInt16]1)              # type: icon
    $writer.Write([UInt16]$sizes.Count)

    $offset = 6 + (16 * $sizes.Count)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        # 256 is encoded as 0 in the directory - the field is a single byte.
        $dimension = 0
        if ($sizes[$i] -lt 256) { $dimension = $sizes[$i] }
        $writer.Write([Byte]$dimension)
        $writer.Write([Byte]$dimension)
        $writer.Write([Byte]0)            # palette colours
        $writer.Write([Byte]0)            # reserved
        $writer.Write([UInt16]1)          # colour planes
        $writer.Write([UInt16]32)         # bits per pixel
        $writer.Write([UInt32]$pngs[$i].Length)
        $writer.Write([UInt32]$offset)
        $offset += $pngs[$i].Length
    }

    foreach ($png in $pngs) { $writer.Write($png) }
    $writer.Flush()

    $resolved = [System.IO.Path]::GetFullPath($Path)
    [System.IO.File]::WriteAllBytes($resolved, $output.ToArray())
    $writer.Dispose()
    $output.Dispose()

    Write-Output ("Wrote {0} ({1:N0} bytes)" -f $resolved, (Get-Item $resolved).Length)
}

$target = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $target | Out-Null

New-SuiteIcon -Path (Join-Path $target "emerald.ico") -Glyph "E" `
    -Start ([System.Drawing.Color]::FromArgb(255, 16, 122, 87)) `
    -End   ([System.Drawing.Color]::FromArgb(255, 5, 66, 52))

New-SuiteIcon -Path (Join-Path $target "emerald-capture.ico") -Glyph "E" -RecordDot `
    -Start ([System.Drawing.Color]::FromArgb(255, 13, 148, 136)) `
    -End   ([System.Drawing.Color]::FromArgb(255, 6, 78, 74))

New-SuiteIcon -Path (Join-Path $target "liveedit.ico") -Glyph "L" `
    -Start ([System.Drawing.Color]::FromArgb(255, 124, 58, 237)) `
    -End   ([System.Drawing.Color]::FromArgb(255, 59, 20, 122)) `
    -Foreground ([System.Drawing.Color]::FromArgb(255, 243, 240, 255))
