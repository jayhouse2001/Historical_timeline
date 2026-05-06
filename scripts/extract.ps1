# Excel(.xlsx) → extract.json
# DRM(IRM)으로 보호된 파일도 본인 계정 Excel COM으로 열어 셀+병합 정보를 추출.
# 사용: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\extract.ps1
$ErrorActionPreference = 'Stop'

$here    = $PSScriptRoot
$root    = Split-Path -Parent $here
$path    = Join-Path $root "My World History.xlsx"
$outJson = Join-Path $here "extract.json"

if (-not (Test-Path $path)) {
  Write-Error "엑셀 파일이 없습니다: $path"
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open($path, 0, $true)
$ws = $wb.Worksheets.Item("WorldHistory")
$used = $ws.UsedRange
$nrows = $used.Rows.Count
$ncols = $used.Columns.Count
$values = $used.Value2

Write-Output "Reading cells: $nrows x $ncols"

$sb = [System.Text.StringBuilder]::new()
[void]$sb.Append('{"rows":'); [void]$sb.Append($nrows)
[void]$sb.Append(',"cols":'); [void]$sb.Append($ncols)
[void]$sb.Append(',"cells":[')
$first = $true
$count = 0

for ($r = 1; $r -le $nrows; $r++) {
  if (($r % 100) -eq 0) { Write-Output ("  row " + $r + " / " + $nrows + "  cells=" + $count) }
  for ($c = 1; $c -le $ncols; $c++) {
    $v = $values[$r, $c]
    if ($null -eq $v) { continue }
    $s = "$v".Trim()
    if ($s.Length -eq 0) { continue }

    $cell = $ws.Cells.Item($r, $c)
    $r1 = $r; $c1 = $c; $r2 = $r; $c2 = $c
    if ($cell.MergeCells) {
      $ma = $cell.MergeArea
      $r1 = [int]$ma.Row
      $c1 = [int]$ma.Column
      $r2 = $r1 + [int]$ma.Rows.Count - 1
      $c2 = $c1 + [int]$ma.Columns.Count - 1
      if ($r -ne $r1 -or $c -ne $c1) { continue }
    }

    $esc = $s -replace '\\','\\' -replace '"','\"' -replace "`r",'\r' -replace "`n",'\n' -replace "`t",'\t'
    if (-not $first) { [void]$sb.Append(',') }
    $first = $false
    [void]$sb.Append('{"r1":'); [void]$sb.Append($r1)
    [void]$sb.Append(',"c1":'); [void]$sb.Append($c1)
    [void]$sb.Append(',"r2":'); [void]$sb.Append($r2)
    [void]$sb.Append(',"c2":'); [void]$sb.Append($c2)
    [void]$sb.Append(',"v":"'); [void]$sb.Append($esc); [void]$sb.Append('"}')
    $count++
  }
}

[void]$sb.Append(']}')
[System.IO.File]::WriteAllText($outJson, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))

Write-Output "Done. cells=$count -> $outJson"
$wb.Close($false); $excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
