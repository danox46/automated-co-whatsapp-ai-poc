param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "META_APP_SECRET",
    "META_SANDBOX_ACCESS_TOKEN",
    "META_WEBHOOK_VERIFY_TOKEN"
  )]
  [string]$Name,

  [string]$Config = "wrangler.mcp.jsonc"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$wranglerPath = Join-Path $projectRoot "node_modules\wrangler\bin\wrangler.js"
$configPath = Join-Path $projectRoot $Config

if (-not (Test-Path -LiteralPath $wranglerPath)) {
  throw "Wrangler is not installed in the project."
}

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "The requested Wrangler configuration does not exist."
}

$secretValue = Get-Clipboard -Raw
if ([string]::IsNullOrWhiteSpace($secretValue)) {
  throw "The clipboard does not contain a secret value."
}

$secretValue = $secretValue.Trim()
if ($secretValue.Length -lt 16 -or $secretValue.Length -gt 8192) {
  throw "The clipboard value is outside the accepted secret length."
}

$process = $null
try {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command node).Source
  $startInfo.WorkingDirectory = $projectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.Arguments = "`"$wranglerPath`" secret put $Name --config `"$configPath`""

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $process.StandardInput.Write($secretValue)
  $process.StandardInput.Close()
  $process.WaitForExit()

  if ($process.ExitCode -ne 0) {
    throw "Wrangler rejected the secret update (exit code $($process.ExitCode))."
  }

  [pscustomobject]@{
    secret = $Name
    stored = $true
    clipboardCleared = $true
  } | ConvertTo-Json -Compress
}
finally {
  $secretValue = $null
  Set-Clipboard -Value " "
  if ($null -ne $process) {
    $process.Dispose()
  }
}
