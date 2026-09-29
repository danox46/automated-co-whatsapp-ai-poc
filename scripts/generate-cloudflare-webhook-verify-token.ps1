param(
  [string]$Config = "wrangler.mcp.jsonc"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$wranglerPath = Join-Path $projectRoot "node_modules\wrangler\bin\wrangler.js"
$configPath = Join-Path $projectRoot $Config
$secretName = "META_WEBHOOK_VERIFY_TOKEN"

if (-not (Test-Path -LiteralPath $wranglerPath)) {
  throw "Wrangler is not installed in the project."
}

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "The requested Wrangler configuration does not exist."
}

$randomBytes = [byte[]]::new(32)
$randomNumberGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$randomNumberGenerator.GetBytes($randomBytes)
$secretValue = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

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
  $startInfo.Arguments = "`"$wranglerPath`" secret put $secretName --config `"$configPath`""

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $process.StandardInput.Write($secretValue)
  $process.StandardInput.Close()
  $process.WaitForExit()

  if ($process.ExitCode -ne 0) {
    throw "Wrangler rejected the secret update (exit code $($process.ExitCode))."
  }

  Set-Clipboard -Value $secretValue
  [pscustomobject]@{
    secret = $secretName
    stored = $true
    copiedForProviderConfiguration = $true
  } | ConvertTo-Json -Compress
}
finally {
  $secretValue = $null
  [Array]::Clear($randomBytes, 0, $randomBytes.Length)
  if ($null -ne $randomNumberGenerator) {
    $randomNumberGenerator.Dispose()
  }
  if ($null -ne $process) {
    $process.Dispose()
  }
}
