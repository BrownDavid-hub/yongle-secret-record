$ErrorActionPreference = 'Stop'
if (-not $env:DEEPSEEK_API_KEY -and -not (Test-Path "$PSScriptRoot\config.local.js")) {
  $secure = Read-Host '请输入 DeepSeek API Key（不会写入文件）' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
& 'C:\Users\1\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' "$PSScriptRoot\server.js"
