# ProvideX bridge: drives the ProvideX.Script COM automation server (pvxcom.exe)
# Protocol: one JSON request per stdin line  {"id":1,"cmd":"list","args":{...}}
#           one JSON response per stdout line {"id":1,"ok":true,"result":...} / {"id":1,"ok":false,"error":"..."}
param([string]$PvxHome = "")

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$cp1252 = [System.Text.Encoding]::GetEncoding(1252)

$script:px = $null
$script:pvxHome = $PvxHome
$script:tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pvxbridge_" + $PID)
New-Item -ItemType Directory -Force -Path $script:tmpDir | Out-Null

$script:serverPid = $null

function Get-Px {
  if ($null -eq $script:px) {
    # remember which pvxcom.exe instance is ours so it can be terminated on exit (it outlives released COM refs)
    $before = @(Get-Process pvxcom -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $script:px = New-Object -ComObject ProvideX.Script
    $new = @(Get-Process pvxcom -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Sort-Object StartTime -Descending)
    if ($new.Count -gt 0) { $script:serverPid = $new[0].Id }
    if ($script:pvxHome) { $script:px.Init($script:pvxHome) } else { $script:px.Init("") }
  }
  return $script:px
}

function Close-Px {
  if ($null -ne $script:px) {
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:px) } catch {}
    $script:px = $null
  }
  if ($script:serverPid) {
    Start-Sleep -Milliseconds 300
    try { Stop-Process -Id $script:serverPid -Force -ErrorAction Stop } catch {}
    $script:serverPid = $null
  }
}

function Pvx-Quote([string]$s) { return '"' + $s.Replace('"', '""') + '"' }

function Pvx-Exec([string]$cmd) {
  $p = Get-Px
  try { $p.Execute($cmd) }
  catch {
    $code = $null
    try { $code = [int]$p.Evaluate('STR(ERR)') } catch {}
    $msg = $null
    if ($null -ne $code) { try { $msg = $p.Evaluate("MSG($code)") } catch {} }
    $e = New-Object System.Exception ("ProvideX error " + $code + ": " + $msg + " [" + $cmd + "]")
    $e.Data['pvxErr'] = $code
    throw $e
  }
}

function Pvx-Eval([string]$expr) { return (Get-Px).Evaluate($expr) }

function New-TempFile([string]$ext) { return Join-Path $script:tmpDir ([guid]::NewGuid().ToString('N') + $ext) }

# LIST the current program workspace to a file and return line records.
function Get-ListedLines {
  $tmp = New-TempFile '.lst'
  Pvx-Exec ('SERIAL ' + (Pvx-Quote $tmp) + ',0')
  try {
    Pvx-Exec ('OPEN LOCK (63)' + (Pvx-Quote $tmp))
    try { Pvx-Exec 'LIST (63)' } finally { Pvx-Exec 'CLOSE (63)' }
    $raw = [System.IO.File]::ReadAllText($tmp, $cp1252)
  } finally { Remove-Item -Force -ErrorAction SilentlyContinue $tmp }
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($l in ($raw -split "`r?`n")) {
    $m = [regex]::Match($l, '^(\d+)([ ?])')
    if ($m.Success) {
      $n = [int]$m.Groups[1].Value
      $full = $null
      try { $full = (Get-Px).Evaluate("LST(PGM($n))") } catch {}
      if ($null -eq $full) { $full = $l }
      $out.Add(@{ n = $n; bad = ($m.Groups[2].Value -eq '?'); text = [string]$full })
    } elseif ($l -match '^(\d+):' -and $out.Count -gt 0) {
      # wrapped continuation (only used when LST() failed)
    }
  }
  return $out
}

function Strip-LineNo([string]$t) {
  $m = [regex]::Match($t, '^\d+[ ?]?')
  if ($m.Success) { return $t.Substring($m.Length) }
  return $t
}

# 'NL' lists statements without the implied LET (purely cosmetic: MERGE re-inserts it)
function Cmd-List($a) {
  Pvx-Exec 'DELETE'
  Pvx-Exec ('LOAD ' + (Pvx-Quote $a.path))
  if ($a.noLet) { Pvx-Exec "SET_PARAM 'NL'" }
  try { $lines = Get-ListedLines } finally { if ($a.noLet) { Pvx-Exec "SET_PARAM -'NL'" } }
  Pvx-Exec 'DELETE'
  return @{ lines = @($lines) }
}

# Prepare source text: returns numbered lines and a map back to source lines.
function Prepare-Source([string]$text) {
  $src = $text -split "`r?`n"
  $numbered = $false
  foreach ($l in $src) { if ($l.Trim() -ne '') { $numbered = ($l -match '^\s*\d+(\s|$)'); break } }
  $lines = New-Object System.Collections.Generic.List[string]
  $map = @{}
  $next = 1
  for ($i = 0; $i -lt $src.Length; $i++) {
    $l = $src[$i]
    if ($l.Trim() -eq '') { continue }
    if ($numbered) {
      $m = [regex]::Match($l, '^\s*(\d+)\s?(.*)$')
      if ($m.Success) {
        $n = [int]$m.Groups[1].Value
        $body = $m.Groups[2].Value
        if ($body.Trim() -eq '') { $body = 'REM' }
        $lines.Add(('{0:D4} {1}' -f $n, $body)); $map[$n] = $i; $next = $n + 1
      } else {
        $lines.Add(('{0:D4} {1}' -f $next, $l)); $map[$next] = $i; $next++
      }
    } else {
      $lines.Add(('{0:D4} {1}' -f $next, $l)); $map[$next] = $i; $next++
    }
  }
  return @{ lines = $lines; map = $map; numbered = $numbered }
}

function Load-Source([string]$text) {
  $prep = Prepare-Source $text
  $tmp = New-TempFile '.txt'
  [System.IO.File]::WriteAllText($tmp, ($prep.lines -join "`r`n") + "`r`n", $cp1252)
  Pvx-Exec 'DELETE'
  $mergeErr = $null
  try { Pvx-Exec ('MERGE ' + (Pvx-Quote $tmp)) } catch { $mergeErr = $_.Exception.Message }
  finally { Remove-Item -Force -ErrorAction SilentlyContinue $tmp }
  return @{ prep = $prep; mergeErr = $mergeErr }
}

function Collect-Diagnostics($prep, $listed) {
  $diags = New-Object System.Collections.Generic.List[object]
  foreach ($r in $listed) {
    if ($r.bad) {
      $src = $prep.map[[int]$r.n]
      $diags.Add(@{ line = $src; stmt = $r.n; code = 20; message = 'Syntax error (ProvideX Error #20)'; text = (Strip-LineNo $r.text) })
    }
  }
  return $diags
}

function Cmd-Check($a) {
  $ld = Load-Source $a.text
  $listed = Get-ListedLines
  $diags = Collect-Diagnostics $ld.prep $listed
  $canon = @()
  if ($a.canonical) { $canon = @($listed | ForEach-Object { @{ n = $_.n; line = $ld.prep.map[[int]$_.n]; text = $_.text } }) }
  Pvx-Exec 'DELETE'
  return @{ diagnostics = @($diags); mergeError = $ld.mergeErr; canonical = $canon }
}

function Cmd-Compile($a) {
  $ld = Load-Source $a.text
  $listed = Get-ListedLines
  $diags = Collect-Diagnostics $ld.prep $listed
  $saved = $false
  if (($diags.Count -eq 0 -or $a.force) -and $null -eq $ld.mergeErr) {
    $out = $a.out
    if (Test-Path -LiteralPath $out) { Remove-Item -Force -LiteralPath $out }
    Pvx-Exec ('SAVE ' + (Pvx-Quote $out))
    $saved = $true
  }
  Pvx-Exec 'DELETE'
  return @{ diagnostics = @($diags); mergeError = $ld.mergeErr; saved = $saved }
}

function Cmd-DumpKeyed($a) {
  # Runs a tiny ProvideX program that writes HTA(key) TAB HTA(record) per line.
  $tmp = New-TempFile '.dmp'
  Pvx-Exec 'DELETE'
  Pvx-Exec ('0010 OPEN (62)' + (Pvx-Quote $a.path))
  Pvx-Exec ('0020 SERIAL ' + (Pvx-Quote $tmp) + ',0; OPEN LOCK (61)' + (Pvx-Quote $tmp))
  Pvx-Exec '0030 K$=KEY(62,END=0060); READ RECORD (62,END=0060)R$'
  Pvx-Exec '0040 PRINT (61)HTA(K$)+$09$+HTA(R$)'
  Pvx-Exec '0050 GOTO 0030'
  Pvx-Exec '0060 CLOSE (61); CLOSE (62)'
  Pvx-Exec '0070 END'
  try { Pvx-Exec 'RUN' } catch { if ($_.Exception.Data['pvxErr'] -ne 34) { throw } }
  Pvx-Exec 'DELETE'
  $recs = New-Object System.Collections.Generic.List[object]
  foreach ($l in [System.IO.File]::ReadAllLines($tmp)) {
    $parts = $l.Split("`t")
    if ($parts.Length -eq 2) { $recs.Add(@{ key = $parts[0]; hex = $parts[1] }) }
  }
  Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  return @{ records = $recs.ToArray() }
}

# A runtime (end-user) activation refuses LIST with Error #61/#62; LIST is what decompiling,
# compiling and syntax checking rely on. Probe it on a throw-away one-line program.
function Test-Development {
  try {
    Pvx-Exec 'DELETE'
    Pvx-Exec '0001 REM'
    [void](Get-ListedLines)
    Pvx-Exec 'DELETE'
    return @{ development = $true; code = $null; message = $null }
  } catch {
    $code = $_.Exception.Data['pvxErr']
    try { Pvx-Exec 'DELETE' } catch {}
    return @{ development = $false; code = $code; message = $_.Exception.Message }
  }
}

function Handle($req) {
  $a = $req.args
  switch ($req.cmd) {
    'init'     {
      if ($a.home) { $script:pvxHome = $a.home }
      if ($script:px) { Close-Px }
      $p = Get-Px
      # 'MC' keeps variable names in mixed case (as Sage compiles them); names stay case-insensitive.
      # Without it MERGE upper-cases every variable of a program on save.
      if ($a.mixedCase -ne $false) { Pvx-Exec "SET_PARAM 'MC'" }
      $lic = Test-Development
      return @{ lwd = [string](Pvx-Eval 'LWD'); serverPid = $script:serverPid; bridgePid = $PID; development = $lic.development; licenceError = $lic.code; licenceMessage = $lic.message }
    }
    'eval'     { return [string](Pvx-Eval $a.expr) }
    'exec'     { Pvx-Exec $a.command; return $true }
    'list'     { return Cmd-List $a }
    'check'    { return Cmd-Check $a }
    'compile'  { return Cmd-Compile $a }
    'dumpKeyed'{ return Cmd-DumpKeyed $a }
    'messages' {
      $res = @{}
      for ($i = 0; $i -le 300; $i++) { try { $res["$i"] = [string](Pvx-Eval "MSG($i)") } catch {} }
      return $res
    }
    'ping'     { return 'pong' }
    default    { throw "Unknown command: $($req.cmd)" }
  }
}

function Send($obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

Send @{ id = 0; ok = $true; result = 'ready' }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $req = $null
  try {
    $req = ConvertFrom-Json $line
    $res = Handle $req
    Send @{ id = $req.id; ok = $true; result = $res }
  } catch {
    $id = $null; if ($req) { $id = $req.id }
    $msg = $_.Exception.Message; if ($env:PVXBRIDGE_DEBUG) { $msg += " @ " + $_.InvocationInfo.PositionMessage }
    if ($msg -match 'RPC server is unavailable|0x800706BA|0x80010108') { Close-Px }
    Send @{ id = $id; ok = $false; error = $msg }
  }
}
Close-Px
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $script:tmpDir
