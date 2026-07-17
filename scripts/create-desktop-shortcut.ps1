Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$electronExecutable = Join-Path $repositoryRoot 'node_modules\electron\dist\electron.exe'
$mainEntry = Join-Path $repositoryRoot 'out\main\index.js'

if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
  throw 'Electron is not installed. Run npm install first.'
}
if (-not (Test-Path -LiteralPath $mainEntry -PathType Leaf)) {
  throw 'The desktop build is missing. Run npm run build:desktop first.'
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Gen Video Tool.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronExecutable
$shortcut.Arguments = '.'
$shortcut.WorkingDirectory = $repositoryRoot
$shortcut.IconLocation = "$electronExecutable,0"
$shortcut.Description = 'Launch Gen Video Tool from the local workspace'
$shortcut.Save()

Write-Output $shortcutPath
