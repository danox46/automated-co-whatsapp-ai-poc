[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $PilotArguments
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
  throw 'The Credential Manager pilot wrapper is available only on Windows.'
}

if (-not ('PilotCredentialManager.NativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace PilotCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NativeCredential {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  public static class NativeMethods {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr credential);
  }
}
'@
}

function Read-GenericCredentialSecret {
  param([Parameter(Mandatory = $true)][string] $Target)

  $credentialPointer = [IntPtr]::Zero
  $genericCredentialType = 1
  if (-not [PilotCredentialManager.NativeMethods]::CredRead($Target, $genericCredentialType, 0, [ref] $credentialPointer)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Windows Credential Manager entry '$Target' is unavailable (Win32 error $errorCode)."
  }

  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $credentialPointer,
      [type][PilotCredentialManager.NativeCredential]
    )
    if ($credential.CredentialBlob -eq [IntPtr]::Zero -or $credential.CredentialBlobSize -eq 0) {
      throw "Windows Credential Manager entry '$Target' has no secret value."
    }
    return [Runtime.InteropServices.Marshal]::PtrToStringUni(
      $credential.CredentialBlob,
      [int]($credential.CredentialBlobSize / 2)
    )
  }
  finally {
    [PilotCredentialManager.NativeMethods]::CredFree($credentialPointer)
  }
}

$credentialTarget = 'AutomatedCo/WhatsAppMCP/PILOT_ADMIN_TOKEN'
$adminSecret = Read-GenericCredentialSecret -Target $credentialTarget
$scriptName = 'pilot-admin.mjs'
if ($PilotArguments.Count -gt 0 -and $PilotArguments[0] -eq 'smoke') {
  $scriptName = 'whatsapp-mcp-smoke.mjs'
  $PilotArguments = @($PilotArguments | Select-Object -Skip 1)
}
elseif ($PilotArguments.Count -gt 0 -and $PilotArguments[0] -eq 'attachment-smoke') {
  $scriptName = 'whatsapp-attachment-smoke.mjs'
  $PilotArguments = @($PilotArguments | Select-Object -Skip 1)
}
$scriptPath = Join-Path $PSScriptRoot $scriptName
$nodeExecutable = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExecutable) {
  $standardNodePath = if ($env:ProgramFiles) {
    Join-Path $env:ProgramFiles 'nodejs\node.exe'
  }
  else {
    'C:\Program Files\nodejs\node.exe'
  }
  if (Test-Path -LiteralPath $standardNodePath) {
    $nodeExecutable = $standardNodePath
  }
}
if (-not $nodeExecutable) {
  throw 'Node.js is unavailable. Install Node.js 20 or newer before running pilot administration.'
}
$processExitCode = 1

try {
  $env:PILOT_ADMIN_TOKEN = $adminSecret
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodeExecutable
  $startInfo.WorkingDirectory = Split-Path -Parent $PSScriptRoot
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $nativeArguments = @($scriptPath) + $PilotArguments
  $startInfo.Arguments = ($nativeArguments | ForEach-Object {
    '"' + $_.Replace('"', '\"') + '"'
  }) -join ' '
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $processExitCode = $process.ExitCode
  if (-not [string]::IsNullOrWhiteSpace($stdout)) {
    [Console]::Out.Write($stdout)
  }
  if (-not [string]::IsNullOrWhiteSpace($stderr)) {
    [Console]::Error.Write($stderr)
  }
}
finally {
  Remove-Item Env:PILOT_ADMIN_TOKEN -ErrorAction SilentlyContinue
  $adminSecret = $null
  if ($null -ne $process) {
    $process.Dispose()
  }
}

exit $processExitCode
