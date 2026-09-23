# pe-dump-str.ps1 -- resolve Ghidra DAT_<va> byte/string constants in a PE image.
# Usage: & scripts/pe-dump-str.ps1 -Image <exe> -Va 0x14048e880,0x14048e8d4 [-Len 32]
param(
  [Parameter(Mandatory=$true)][string]$Image,
  [Parameter(Mandatory=$true)][string]$Va,
  [int]$Len = 24
)
$ErrorActionPreference = 'Stop'
function Parse-Hex([string]$s) {
  $t = $s.Trim()
  if ($t.StartsWith('0x') -or $t.StartsWith('0X')) { $t = $t.Substring(2) }
  return [System.Numerics.BigInteger]::Parse($t, [System.Globalization.NumberStyles]::HexNumber)
}
$fs = [System.IO.File]::OpenRead($Image)
try {
  $br = New-Object System.IO.BinaryReader($fs)
  $fs.Position = 0x3C
  $e_lfanew = $br.ReadInt32()
  $fs.Position = $e_lfanew + 4 + 2          # NumberOfSections
  $numSec = $br.ReadUInt16()
  $fs.Position = $e_lfanew + 4 + 16         # SizeOfOptionalHeader
  $sizeOpt = $br.ReadUInt16()
  $optOff = $e_lfanew + 4 + 20
  $fs.Position = $optOff + 0x18             # ImageBase (PE32+)
  $imageBase = [System.Numerics.BigInteger]$br.ReadUInt64()
  $secOff = $optOff + $sizeOpt
  $secs = @()
  for ($i = 0; $i -lt $numSec; $i++) {
    $fs.Position = $secOff + $i * 40
    $nameB = $br.ReadBytes(8)
    $name = ([System.Text.Encoding]::ASCII.GetString($nameB)).TrimEnd([char]0)
    $vsize = $br.ReadUInt32(); $vaddr = $br.ReadUInt32()
    $rsize = $br.ReadUInt32(); $raddr = $br.ReadUInt32()
    $secs += [pscustomobject]@{Name=$name;VSize=$vsize;VAddr=$vaddr;RSize=$rsize;RAddr=$raddr}
  }
  Write-Output ("ImageBase=0x{0:X}  sections={1}" -f $imageBase, ($secs.Name -join ','))
  foreach ($v in ($Va -split ',')) {
    $addr = Parse-Hex $v
    $rva = [int64]($addr - $imageBase)
    $sec = $secs | Where-Object { $rva -ge $_.VAddr -and $rva -lt ($_.VAddr + [Math]::Max($_.VSize,$_.RSize)) } | Select-Object -First 1
    if (-not $sec) { Write-Output ("0x{0:X}: NO SECTION for rva 0x{1:X}" -f $addr,$rva); continue }
    $fs.Position = $sec.RAddr + ($rva - $sec.VAddr)
    $bytes = $br.ReadBytes($Len)
    $asc = ($bytes | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { '.' } }) -join ''
    $hex = ($bytes | ForEach-Object { '{0:X2}' -f $_ }) -join ' '
    Write-Output ("0x{0:X} [{1}] asc='{2}'" -f $addr,$sec.Name,$asc)
    Write-Output ("            hex= {0}" -f $hex)
  }
} finally { $fs.Dispose() }
