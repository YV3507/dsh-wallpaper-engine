# tmp-wait-and-measure.ps1 -- ASCII only (Windows PowerShell 5.1 reads non-BOM .ps1 as ANSI).
# Wait until lib/we-renderer/** parses again (a parallel edit left model.js:491 with a stray comma),
# then run three sampling configurations back to back. This script never modifies we-renderer files.
$ErrorActionPreference = 'Continue'
$log = '.test-cache/tmp-wait-and-measure.log'
function Log($m) { $m | Tee-Object -FilePath $log -Append }

"=== wait start $(Get-Date -Format o) ===" | Out-File -Encoding utf8 $log

$deadline = (Get-Date).AddMinutes(30)
$ok = $false
while ((Get-Date) -lt $deadline) {
  node --check lib/we-renderer/model.js 2>$null
  if ($LASTEXITCODE -eq 0) {
    $bad = @()
    Get-ChildItem -Recurse lib/we-renderer -Include *.js,*.mjs | ForEach-Object {
      node --check $_.FullName 2>$null
      if ($LASTEXITCODE -ne 0) { $bad += $_.Name }
    }
    if ($bad.Count -eq 0) { $ok = $true; break }
    Log "still broken: $($bad -join ',')"
  }
  Start-Sleep -Seconds 15
}
if (-not $ok) { Log 'TREE STILL BROKEN after 30min -- abort'; exit 1 }
Log "tree OK $(Get-Date -Format o)"

node -e "const fs=require('fs'),path=require('path'),c=require('crypto');const root='lib/we-renderer';const out=[];const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(/[.](js|mjs|h)$/.test(e.name)){out.push(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0,16)+' '+p);}}};walk(root);out.sort();fs.writeFileSync('.test-cache/tmp-tree-fingerprint.txt',out.join([char]10)+[char]10);console.log('treeFingerprint',c.createHash('sha256').update(out.map(s=>s.split(' ')[0]).join('')).digest('hex').slice(0,16));" 2>$null | Tee-Object -FilePath $log -Append

$scenes = 'beach,deep_space,razer_bedroom,eagleflag,retro,dna_fragment,arsenal,ricepod,audiophile,shimmering_particles,techno,fantasticcar,demon_core,neon_sunset,dino_run,razer_vortex'

Log '=== CONFIG A: DSH_WE_PREVIEW_CAL=1 + DSH_WE_NO_SAMPLING_REFINE=1 (previous default) ==='
node scripts/tmp-sampling-ab.mjs --phase=after --env=DSH_WE_PREVIEW_CAL=1 --env=DSH_WE_NO_SAMPLING_REFINE=1 --scenes=$scenes --runs=1 --out=.test-cache/sampling-ab-cfgA-calON.json 2>$null | Select-String -Pattern 'phase=|^  [a-z]' | ForEach-Object { $_.Line } | Tee-Object -FilePath $log -Append

Log '=== CONFIG C: default (preview OFF + refine ON) ==='
node scripts/tmp-sampling-ab.mjs --phase=after --scenes=$scenes --runs=1 --out=.test-cache/sampling-ab-cfgC-default.json 2>$null | Select-String -Pattern 'phase=|^  [a-z]' | ForEach-Object { $_.Line } | Tee-Object -FilePath $log -Append

Log '=== CONFIG B: stage1 only (preview OFF + refine OFF) on degenerate scenes ==='
node scripts/tmp-sampling-ab.mjs --phase=after --env=DSH_WE_NO_SAMPLING_REFINE=1 --scenes=arsenal,audiophile,shimmering_particles --runs=1 --out=.test-cache/sampling-ab-cfgB-stage1.json 2>$null | Select-String -Pattern 'phase=|^  [a-z]|xuanze|候选' | ForEach-Object { $_.Line } | Tee-Object -FilePath $log -Append

Log '=== DETERMINISM: 3 separate node processes x 5 scenes (config C) ==='
foreach ($i in 1..3) {
  Log "--- process $i ---"
  node scripts/tmp-sampling-ab.mjs --phase=after --scenes=beach,retro,audiophile,shimmering_particles,arsenal --runs=1 --out=".test-cache/sampling-ab-det-$i.json" 2>$null | Select-String -Pattern '^  [a-z]' | ForEach-Object { $_.Line } | Tee-Object -FilePath $log -Append
}
Log 'ALL MEASUREMENTS DONE'
