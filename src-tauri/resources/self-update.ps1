param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,

  [Parameter(Mandatory = $true)]
  [string]$Executable
)

$ErrorActionPreference = "Stop"

Start-Sleep -Milliseconds 900

$process = Start-Process `
  -FilePath $Installer `
  -ArgumentList "/S" `
  -Wait `
  -PassThru

if ($process.ExitCode -ne 0) {
  exit $process.ExitCode
}

Start-Sleep -Milliseconds 700
Start-Process -FilePath $Executable
