# show-lines.ps1 - print a 1-based line range from a (possibly huge) text file.
# Usage: & .\show-lines.ps1 -Path <file> -From 100 -To 200 [-Number]
# Reads via StreamReader with an early break, so it does NOT scan the whole file.
param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][int]$From,
  [Parameter(Mandatory=$true)][int]$To,
  [switch]$Number
)
$fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
try {
  $sr = New-Object System.IO.StreamReader($fs)
  try {
    $i = 0
    while (-not $sr.EndOfStream) {
      $line = $sr.ReadLine()
      $i++
      if ($i -ge $From) {
        if ($Number) { "{0}: {1}" -f $i, $line } else { $line }
      }
      if ($i -ge $To) { break }
    }
  } finally { $sr.Dispose() }
} finally { $fs.Dispose() }
